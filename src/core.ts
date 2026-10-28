/**
 * codebuddy 族供应商共享实现。
 *
 * 国内 CodeBuddy（copilot.tencent.com）与国际版 WorkBuddy（www.workbuddy.ai）
 * 是同一个腾讯网关的两个部署：契约完全一致（OAuth 轮询登录 + OpenAI 兼容流式
 * chat + billing/meter 积分签到），只差 base、路径候选、指纹头、兜底模型这几张
 * 配置表。全部共享逻辑住在这里，差异收敛进 `SupplierProfile`；cn.ts / en.ts 各给
 * 一份 profile。
 *
 * 上游：OpenAI 兼容网关
 *   - chat:   POST <chatUrls[0]>（强制流式；非流式上游 400 拒绝）
 *   - login:  OAuth 轮询：POST state → 浏览器打开 authUrl →
 *             轮询 GET token?state=... 直到 code 0（accessToken）
 *   - refresh:POST token/refresh（X-Refresh-Token 头）
 *
 * OAuth 账号：走「添加链接 + 连接池」（同 traework），凭证存通用
 * CredentialStore（auths/{id}/{uid}.json，{ nickname, accessToken,
 * refreshToken, expiresAt }）。
 */
import type { ChatRequest, ModelInfo } from './types.ts'
import type { AccountState, ChatOnceResult, SupplierEnv, SupplierModule, SupplierStatusNow } from './contract.ts'
import { forceNeutralHead, isChannelRejectBody, perturbChannelFingerprints } from './body.ts'

/**
 * 一个上游网关的差异描述 —— codebuddy 族两个供应商的全部不同都在这里。
 *
 * 加第三个同族网关（如某地区专有域）= 加一份 profile，共享逻辑一行不用动。
 */
export interface SupplierProfile {
  /** 供应商 id。**同时是凭证/配置/积分缓存的存储键**，改它等于换一个供应商。 */
  id: string
  /** 面板展示名。 */
  name: string
  /**
   * 面板图标（内联 data URI）。
   *
   * **必须内联，不能放网络 URL**：图标不该依赖另一个服务活着，更不该依赖特定端口。
   */
  icon: string
  /** 池内排序（越小越靠前）。 */
  priority: number
  /**
   * chat 端点候选，按序尝试；仅 404/405 换下一个。
   *
   * 上游新旧路径分叉（国际版首选 /console，国内走 /v2），用候选列表表达，
   * 单路径供应商给一个元素即可 —— 单元素循环与直连等价。
   */
  chatUrls: string[]
  /** 云端产品配置（模型列表）端点。 */
  configUrl: string
  /** OAuth：申请 state / 轮询 token / 刷新 token 三个端点。 */
  stateUrl: string
  tokenUrl: string
  refreshUrl: string
  /** billing/meter 积分端点候选（国际版无 /v2 前缀，404 回退带 /v2）。 */
  usageUrls: string[]
  /**
   * **企业号**余额端点候选（`get-enterprise-user-usage`）。
   *
   * 为什么必须单列：个人表 `get-user-resource` 对企业成员答 HTTP 200 + **空
   * Accounts** —— 一个「你没有额度」的合法形状，而它其实是假的（额度挂在企业
   * 账号下）。照个人表读，面板就把有额度的企业号显示成 0，比报错更糟。
   * 企业表回 `{ credit, limitNum, cycleResetTime }`，**剩余 = limitNum - credit**
   * （`credit` 是已消耗，读成余额会把答案反过来）。
   *
   * 缺省 = 这个网关不提供企业表（本供应商只走个人表）。
   */
  enterpriseUsageUrls?: string[]
  /** billing/meter 签到端点候选（同上）。 */
  checkinUrls: string[]
  /**
   * 签到**状态**读端点候选（`checkin-activity-status`，只读）。
   *
   * 缺省 = 不预读，直接签发（旧行为）。有它时先读一次：`active=false` 说明该
   * 区域没开这个活动（国际侧实测如此）→ 直接报「未开放」，不去花一次写请求；
   * `today_checked_in=true` → 报「已签到」并刷新积分，同样不写。
   */
  checkinStatusUrls?: string[]
  /** 上游网关域名，用于 `X-Domain` 头。 */
  domain: string
  /** 出站请求头（供应商指纹；Authorization 由共享逻辑按需追加）。 */
  headers: (token?: string, extra?: Record<string, string>) => Record<string, string>
  /** 错误文本前缀，如 `codebuddy 11133: ...` / `workbuddy 11133: ...`。 */
  errPrefix: string
  /** 账号 uid 前缀（`cb-1` / `wb-1`）。 */
  uidPrefix: string
  /** 默认昵称（上游不下发昵称，面板按它展示）。 */
  defaultNickname: string
  /** 上游拉不到模型时的兜底列表（不是「当前可用模型」，只是最后退路）。 */
  fallbackModels: ModelInfo[]
  /** chat 请求额外头（国际版多一个 Accept）。 */
  chatExtraHeaders?: Record<string, string>
  /**
   * 网关 code 语义归类：把「瞬时/请求类」错误归 rate_limit，
   * 避免按 unknown 攒错误把整个池冷却掉。返回 undefined = 说不清。
   */
  classifyGatewayCode?: (code: number) => AccountState | undefined
  /**
   * 出站请求体归一（防网关白名单校验，如 11128 首条须 system、11101 tool_choice 须 string）。
   * 缺省 = 只做 model/stream/推理等级改写。
   */
  normalizeBody?: (obj: Record<string, unknown>) => void
  /**
   * 序列化**之后**的请求体归一。与 `normalizeBody` 分成两步是因为顺序有语义：
   * 「首条不是 system 就补一条」必须在「developer → system」之后跑，否则首条
   * developer 会被补出重复的 system。缺省 = 不改。
   */
  normalizeBodyText?: (body: string) => string
}

/** 默认前缀（用户可在面板改；loader 包装会优先用 store 里的值）。 */
const REFRESH_SKEW_MS = 24 * 3600_000 // 到期前 24 小时内刷新（同 traework）
/**
 * 主动刷新上限：accessToken 距**签发**超过这么久就刷新轮换一次，不等到临到期。
 *
 * 为什么需要这个：上游返回的 JWT 有效期可以很长（实测到 ~350 天）。只靠
 * REFRESH_SKEW_MS（临到期 24h）的话，一份签发很久的旧 token 会被一直复用——
 * 直到腾讯把它**服务端吊销**（401，刷新也报 `12153: Offline user session not
 * found`，见 2026-06 批 cb 号实测）。定期轮换让 token 保持新鲜，避免长期复用
 * 同一凭据被风控判成问题。15 天 = 最长刷新期诉求。
 */
const REFRESH_MAX_ISSUED_MS = 15 * 24 * 3600_000
const POLL_INTERVAL_MS = 5000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
/** 今日已签到（幂等，视为成功）。 */
const ALREADY_CHECKED_IN_CODE = 10001
const CREDITS_TTL_MS = 10 * 60 * 1000 // 积分缓存 10 分钟
/**
 * 拿不到积分时报它（**不是 0**）：核心靠这个区分「没拿到」和「拿到了 0」，
 * 从而保留上次持久化的值。报 0 会把缓存冲成 0 —— 重启后面板永久显示 0
 * 积分就是这么来的。
 */
const CREDITS_UNKNOWN = -1
/**
 * 会续期的基础包（Refill）判据 —— 旧口径，**已被 `CapacityType === 4` 取代**。
 *
 * 保留常量是因为仍有部署只回 CycleEndTime/DeductionEndTime 这一对时间戳：
 * 那时「周期结束远早于资源到期」= 会续期的包。两条判据都在 `isMonthlyPackage`
 * 里，先认 CapacityType（官方客户端口径），认不出才退回这对时间戳。
 */
const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000
/**
 * 积分请求体：**不能发 `{}`**。
 *
 * 2026-10-28 对齐实测（参照 dsh-connect-workbuddy 的 `get-user-resource` 调用）：
 * 官方客户端带分页 + 产品码 + 状态 + 到期时间窗，缺了这些上游按自己的默认值
 * 返回，包数一多就会漏（求和偏小）。这些字段不是可选装饰，是查询条件。
 */
const CREDITS_PAGE_SIZE = 100
const CREDITS_PRODUCT_CODE = 'p_tcaca'
/** 0 = 生效中，3 = 待生效（和官方客户端一致，两态都算余额）。 */
const CREDITS_PACKAGE_STATUS = [0, 3]
/**
 * 11128 重试阶梯的总尝试次数上限（含首发）。
 *
 * 三级：原样 → 强制中性头 → 零宽散点。每一级只在「确实改了字节」且「上一次
 * 是渠道闸拒绝」时才发，所以最坏情况是 3 次、常见情况 1 次。
 */
const CHAT_ATTEMPT_LIMIT = 3
/** 非聊天模型（生图/视频等）：网关 chat 端点不支持，面板不该出现。 */
const NON_CHAT_TAGS = /text-to-image|image-to-image|text-to-video|image-to-video/i

interface CodeBuddyCred {
  nickname: string
  accessToken: string
  refreshToken: string
  expiresAt: number // ms epoch
  /**
   * 企业 ID（可选）。有它 = 这个号是企业成员，余额要读企业表。
   *
   * 现在**没人写它**：OAuth 换 token 的响应里没有企业信息。留着是因为它是唯一
   * 可信的判据来源（将来登录响应带上就直接落盘），今天的回退路径见
   * `enterpriseIdOf`。
   */
  enterpriseId?: string
}

/** JWT payload（不验签，只读声明）。解不出来返回 undefined。 */
function tokenPayload(accessToken: string): Record<string, unknown> | undefined {
  const dot = accessToken.split('.')
  const payload = dot.length >= 2 ? (dot[1] ?? '') : ''
  if (payload === '') return undefined
  let json: string
  try {
    json = typeof Buffer !== 'undefined' ? Buffer.from(payload, 'base64').toString('utf8') : atob(payload)
  } catch {
    return undefined
  }
  try {
    const j = JSON.parse(json) as unknown
    return typeof j === 'object' && j !== null && !Array.isArray(j)
      ? j as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 JWT accessToken 的 payload 解出签发时间 `iat`（Unix 秒 → ms）。
 * 解不出来返回 null —— 调用方应回落到仅按 `expiresAt` 判（行为与旧版一致）。
 */
function tokenIssuedAtMs(accessToken: string): number | null {
  const iat = tokenPayload(accessToken)?.iat
  return typeof iat === 'number' && Number.isFinite(iat) ? iat * 1000 : null
}

/**
 * 这个号是不是企业成员，是的话返回企业 ID。
 *
 * 顺序：落盘字段 > JWT 声明。JWT 的字段名在不同部署上见过几种拼法，所以按
 * 候选名扫一遍 —— 拿不到就返回 undefined，**不猜**（猜错的代价是把个人号
 * 的余额读到企业表上去，那是把「有钱」显示成 0）。
 *
 * 刻意**不**据此改出站请求头（`X-Enterprise-Id` / `X-Tenant-Id`）：那是一次
 * 未实测的字节改动，而企业判定只影响「读哪张余额表」这一件事。
 */
const ENTERPRISE_CLAIMS = ['enterpriseId', 'enterprise_id', 'entId', 'tenantId', 'corpId'] as const

function enterpriseIdOf(cred: CodeBuddyCred): string | undefined {
  if (typeof cred.enterpriseId === 'string' && cred.enterpriseId !== '') return cred.enterpriseId
  const payload = tokenPayload(cred.accessToken)
  if (payload === undefined) return undefined
  for (const key of ENTERPRISE_CLAIMS) {
    const v = payload[key]
    if (typeof v === 'string' && v !== '') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

/** 网关错误：code 非 0 时提取 msg。 */
function gatewayError(prefix: string, body: string, status: number): string {
  try {
    const j = JSON.parse(body) as { code?: number; msg?: string; message?: string }
    if (j.code && j.code !== 0) return `${prefix} ${j.code}: ${j.msg || j.message || ''}`.trim()
    if (j.message) return `${prefix} ${status}: ${j.message}`
  } catch {
    // 非 JSON
  }
  return `upstream ${status}: ${body.slice(0, 200)}`
}

/**
 * 上游声明的重置时刻（epoch ms）——限流文案自带：「…将在 2026-10-15 20:26:05
 * UTC+8 重置…」。解析出来交给核心冷到那个点；**解析不出就退回 undefined**，
 * 核心照旧指数退避（fail-open：文案格式变了不该把请求打死）。
 * 天花板：只认 `YYYY-MM-DD HH:mm:ss UTC±X` 这一种实测格式，英文版重置文案
 * （WorkBuddy）遇到再补——未匹配时行为与改动前完全一致。
 */
function resetAtOf(body: string): number | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*UTC([+-]\d{1,2})/.exec(body)
  if (!m) return undefined
  const [, y, mo, d, h, mi, s, off] = m
  // UTC+8 的墙钟 20:26:05 = UTC 12:26:05，故减去偏移小时数
  return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!) - +off! * 3_600_000
}

/**
 * 上游的时间格式：`YYYY-MM-DD HH:mm:ss`，**本地时区墙钟**（没有 Z、没有偏移）。
 * 积分查询的时间窗必须按这个格式发，ISO 串会被当成非法值。
 */
function formatLocalTime(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + ` ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

/** 上游回的时间戳（字符串墙钟或 epoch 毫秒）→ epoch ms。解析不出 = undefined。 */
function parseInstant(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/** 积分保留两位（上游 Precise 字段本身就是两位精度，多余小数是浮点噪声）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 一次请求的会话身份（三个 UUID）。
 *
 * 网关侧有「conversation id 缺失」这一支 11128：官方客户端每个请求都带这三个头，
 * 不带就是「不是官方客户端」。值必须**每请求现生成**（这是请求身份，不是会话
 * 持久化）——复用同三个值反而更像伪造。格式沿用带连字符的 v4（实测 200），
 * 没换 32 位 v7 是因为后者只是用量页显示的保真度问题，不是闸。
 *
 * `globalThis.crypto` 不在时（老宿主）返回空对象：宁可少三个头，也不要抛。
 */
function conversationIdHeaders(): Record<string, string> {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid !== 'function') return {}
  const messageId = uuid.call(globalThis.crypto)
  return {
    'X-Conversation-ID': uuid.call(globalThis.crypto),
    'X-Conversation-Request-ID': uuid.call(globalThis.crypto),
    'X-Conversation-Message-ID': messageId,
  }
}

/** 剥本供应商 alias 前缀（只剥自己的，模型 id 自带的斜杠保留，否则自定义模型
 *  `org/name` 会被剥成 `name`，请求必然 404）。 */
function stripAlias(model: string, alias: string): string {
  return alias !== '' && model.startsWith(`${alias}/`) ? model.slice(alias.length + 1) : model
}

/** 沿候选路径逐个 fetch，命中首个「非 fallback 状态」即返回；fallback 状态换下一候选。
 *  用于上游新旧路径分叉（国际版 billing 无 /v2 前缀，chat 先 console 后 /v2）。 */
async function fetchWithFallback(
  urls: string[],
  init: RequestInit,
  fallbackStatuses: number[],
): Promise<Response> {
  let last: Response | undefined
  for (let i = 0; i < urls.length; i++) {
    const r = await fetch(urls[i]!, init)
    if (i < urls.length - 1 && fallbackStatuses.includes(r.status)) {
      last = r
      continue
    }
    return r
  }
  return last ?? (undefined as unknown as Response)
}

/** 按 profile 造一个供应商模块。 */
export function createSupplier(p: SupplierProfile): (env: SupplierEnv) => SupplierModule {
  return function factory(env: SupplierEnv): SupplierModule {
    const id = p.id
    const creds = env.credentials
    const store = env.store
    const log = env.log

    /** 进行中的登录 state。 */
    let pendingState: string | undefined
    let pendingUid: string | undefined

    /** 积分缓存：uid → { value, at }（status() 同步返回，过期后台异步刷新）。
     *  积分本身由核心持久化（supplier-config.json），这里只管内存 TTL。 */
    const creditsCache = new Map<string, { value: number; at: number }>()
    /** 正在拉积分的 uid：并发 status() 共享同一次请求，别把上游按 N 倍打。 */
    const creditsInflight = new Set<string>()
    /** 上游拉到的模型（拉取失败时回退它，避免面板空模型）。 */
    let modelsCache: ModelInfo[] | undefined
    /** 正在进行的拉取：并发调用共享同一次请求，别把上游按 N 倍打。 */
    let inflight: Promise<ModelInfo[]> | undefined

    function listUids(): string[] {
      return creds.list(id)
    }

    function getCred(uid: string): CodeBuddyCred | undefined {
      return creds.get<CodeBuddyCred>(id, uid)
    }

    /** 账号顺序：池顺序优先，未配置按凭证原始顺序。 */
    function orderedUids(): string[] {
      const all = listUids()
      const order = store.get(id).poolOrder
      return [...order.filter((u) => all.includes(u)), ...all.filter((u) => !order.includes(u))]
    }

    /** 当前前缀（与 loader 包装一致：store 覆盖默认值）。 */
    function currentAlias(): string {
      return env.store.get(id).alias || id
    }

    /**
     * 从一个账号拉上游模型列表（/v3/config）。
     *
     * 用哪个账号都行（实测同一租户下发的列表一致），所以只取第一个能用的凭证：
     * 遍历所有账号只会把上游按 N 倍打，换不来更多信息。
     */
    async function fetchModelsFromUpstream(): Promise<ModelInfo[]> {
      for (const uid of orderedUids()) {
        const cred = getCred(uid)
        if (cred === undefined) continue
        let token = cred.accessToken
        try {
          token = (await refreshIfNeeded(uid, cred)).accessToken
        } catch {
          // 刷新失败继续用旧 token：过期由上游返回码体现
        }
        try {
          const resp = await fetch(p.configUrl, {
            method: 'GET',
            headers: p.headers(token),
            signal: AbortSignal.timeout(15000),
          })
          if (!resp.ok) continue
          const j = (await resp.json()) as {
            code?: number
            data?: { models?: Array<{ id?: string; maxInputTokens?: number; tags?: string[] }> }
          }
          if (j.code !== 0) continue
          const raw = j.data?.models
          if (!Array.isArray(raw)) continue
          const out: ModelInfo[] = []
          const seen = new Set<string>()
          for (const m of raw) {
            if (typeof m.id !== 'string' || m.id === '' || seen.has(m.id)) continue
            // 生图/视频模型走不了 chat 端点，面板列出来只会误导
            if (m.tags !== undefined && m.tags.some((t) => NON_CHAT_TAGS.test(t))) continue
            seen.add(m.id)
            // 上下文长度只认 maxInputTokens：maxAllowedSize 是另一套口径
            // （实测 default 模型 56000 vs 200000），优先取它会把上下文报小一截。
            // 除以 1000 与 openrouter/nvidia 插件一致（面板按 k 显示）。
            const ctx = Number(m.maxInputTokens)
            out.push(Number.isFinite(ctx) && ctx > 0 ? { id: m.id, context_length: Math.round(ctx / 1000) } : { id: m.id })
          }
          if (out.length > 0) return out
        } catch {
          // 换下一个账号
        }
      }
      return []
    }

    /** 模型列表：上游拉取，失败回退上次成功结果，再不济用内置兜底表。 */
    async function allModels(force: boolean): Promise<ModelInfo[]> {
      // 核心按 TTL 缓存，force=false 的频繁调用直接用缓存，别打上游
      if (!force && modelsCache !== undefined) return modelsCache
      if (inflight !== undefined) return inflight
      inflight = fetchModelsFromUpstream()
        .then((list) => {
          if (list.length > 0) {
            modelsCache = list
            return list
          }
          return modelsCache ?? p.fallbackModels
        })
        .catch(() => modelsCache ?? p.fallbackModels)
        .finally(() => {
          inflight = undefined
        })
      return inflight
    }

    /** 拉取积分并写入缓存（并发去重：同号并发 status() 只打一次上游）。 */
    async function refreshCredits(uid: string): Promise<number | undefined> {
      if (creditsInflight.has(uid)) return undefined
      creditsInflight.add(uid)
      try {
        return await fetchCredits(uid)
      } finally {
        creditsInflight.delete(uid)
      }
    }

    /** 积分查询请求体（分页 + 产品码 + 状态 + 到期时间窗，顺序同官方客户端）。 */
    function creditsRequestBody(): string {
      const now = new Date()
      return JSON.stringify({
        PageNumber: 1,
        PageSize: CREDITS_PAGE_SIZE,
        ProductCode: CREDITS_PRODUCT_CODE,
        Status: CREDITS_PACKAGE_STATUS,
        PackageEndTimeRangeBegin: formatLocalTime(now),
        PackageEndTimeRangeEnd: formatLocalTime(new Date(now.getTime() + 365 * 101 * 24 * 3600_000)),
      })
    }

    /** 个人余额表。`accounts: 0` 是**有意义的信号**（企业成员会拿到合法形状的空表）。 */
    async function fetchPersonalCredits(token: string): Promise<{ value: number; accounts: number } | undefined> {
      const resp = await fetchWithFallback(
        p.usageUrls,
        {
          method: 'POST',
          headers: p.headers(token, { 'Content-Type': 'application/json' }),
          body: creditsRequestBody(),
          signal: AbortSignal.timeout(20000),
        },
        [404],
      )
      const j = (await resp.json()) as {
        code?: number
        data?: { Response?: { Data?: { Accounts?: Array<Record<string, unknown>> } } }
      }
      const accounts = j.data?.Response?.Data?.Accounts
      if (!resp.ok || j.code !== 0 || !Array.isArray(accounts)) return undefined
      let remain = 0
      for (const a of accounts) {
        if (a === null || typeof a !== 'object') continue
        const num = (k: string): number => (typeof a[k] === 'number' ? a[k] as number : 0)
        /** 每个容量都另发一份 `*Precise` 字符串（带整数位丢掉的两位小数）。 */
        const preciseField = (k: string): number => {
          const raw = a[`${k}Precise`]
          if (typeof raw === 'string' && raw !== '') {
            const n = Number.parseFloat(raw)
            if (Number.isFinite(n)) return n
          }
          if (typeof raw === 'number' && Number.isFinite(raw)) return raw
          return num(k)
        }
        /**
         * 这个包是不是「按周期续期的月度资源」。
         *
         * 首选 `CapacityType === 4`（官方客户端口径）：4 = 月度容量资源，1 =
         * 按扣减消耗的赠送包。老部署不回 CapacityType 时退回时间戳判据：
         * 周期结束远早于资源到期 = 会续期，否则是一次性赠送。
         */
        const isMonthlyPackage = (): boolean => {
          const type = a.CapacityType
          if (typeof type === 'number' && Number.isFinite(type)) return type === 4
          const cycleEnd = parseInstant(a.CycleEndTime)
          const deductionEnd = parseInstant(a.DeductionEndTime)
          return cycleEnd !== undefined && deductionEnd !== undefined && deductionEnd - cycleEnd > REFILL_GAP_MS
        }
        const monthly = isMonthlyPackage()
        // 有 cycle 家族就一律读它（见 isMonthlyPackage 的说明）：赠送包两族数值
        // 相同，统一读不损失；月度资源两族会差一整个月额度，读错会高报。
        const hasCycle = a.CycleCapacityRemain !== undefined || a.CycleCapacityRemainPrecise !== undefined
        const raw = hasCycle ? preciseField('CycleCapacityRemain') : preciseField('CapacityRemain')
        const capped = raw < 0 ? 0 : raw
        // 一次性赠送包：已耗尽或已过期就不进余额（月度资源永不过期，始终计入）
        const expiry = monthly ? undefined : parseInstant(a.ExpiredTime) ?? parseInstant(a.CycleEndTime)
        if (!monthly && (capped <= 0 || (expiry !== undefined && expiry <= Date.now()))) continue
        remain += capped
      }
      return { value: round2(remain), accounts: accounts.length }
    }

    /**
     * 企业余额表（`get-enterprise-user-usage`）。
     *
     * 个人表对企业成员答「空 Accounts」，所以只能读这张表：它回
     * `{ credit, limitNum, cycleResetTime }`，**剩余 = limitNum - credit**
     * （`credit` 是已消耗 —— 读成余额会把答案倒过来）。缺任一个数 = 没有可读
     * 余额，返回 undefined（报 0 就是要把这个分支修掉的病）。
     */
    async function fetchEnterpriseCredits(token: string): Promise<number | undefined> {
      const urls = p.enterpriseUsageUrls
      if (urls === undefined) return undefined
      const resp = await fetchWithFallback(
        urls,
        {
          method: 'POST',
          headers: p.headers(token, { 'Content-Type': 'application/json' }),
          body: '{}',
          signal: AbortSignal.timeout(20000),
        },
        [404],
      )
      const j = (await resp.json()) as { code?: number; data?: Record<string, unknown> }
      if (!resp.ok || j.code !== 0 || j.data === undefined || j.data === null) return undefined
      // 实测两种形状都出现过：数字直接挂 data 下，或包一层 Data
      const inner = typeof j.data.Data === 'object' && j.data.Data !== null
        ? j.data.Data as Record<string, unknown>
        : j.data
      const limit = typeof inner.limitNum === 'number' && Number.isFinite(inner.limitNum) ? inner.limitNum : undefined
      const used = typeof inner.credit === 'number' && Number.isFinite(inner.credit) ? inner.credit : undefined
      if (limit === undefined || used === undefined) return undefined
      return round2(Math.max(0, limit - used))
    }

    async function fetchCredits(uid: string): Promise<number | undefined> {
      const cred = getCred(uid)
      if (!cred) return undefined
      try {
        const fresh = await refreshIfNeeded(uid, cred)
        const token = fresh.accessToken
        const enterpriseId = enterpriseIdOf(fresh)
        if (enterpriseId !== undefined) {
          // 判据只有它：个人表对企业成员答的「空表」不是余额，不能拿它当分支依据
          // （2026-10-28 对齐 dsh-connect-workbuddy issue #124 的口径）。
          const value = await fetchEnterpriseCredits(token)
          if (value !== undefined) {
            creditsCache.set(uid, { value, at: Date.now() })
            return value
          }
          return undefined
        }
        const personal = await fetchPersonalCredits(token)
        if (personal !== undefined && personal.accounts > 0) {
          creditsCache.set(uid, { value: personal.value, at: Date.now() })
          return personal.value
        }
        // 走到这里有两种可能：个人表读失败，或读成功但一个包都没有。
        // 后者正是企业成员的形状，而企业 ID 我们并不总能拿到（登录响应不下发），
        // 所以补探一次企业表 —— 这是**回退**，不是分支依据：企业表读不出可用
        // 余额时仍报 undefined（-1），核心保留上次的值。
        if (personal !== undefined && p.enterpriseUsageUrls !== undefined) {
          const value = await fetchEnterpriseCredits(token)
          if (value !== undefined) {
            creditsCache.set(uid, { value, at: Date.now() })
            return value
          }
        }
      } catch {
        // 积分拉取失败不阻塞主流程
      }
      return undefined
    }

    /**
     * 签到状态（只读，不改账号状态）。
     *
     * `active` 与 `today_checked_in` 是两件事，别看混：国际侧那些号回
     * `today_checked_in=false` 不是字段坏了，而是**该区活动未开启**
     * （同响应 `active=false`）。2026-10-10 本机 4 个 CN 号实测一致回
     * `active=true, today_checked_in=true, streak_days=11` —— 字段本身可靠。
     */
    async function fetchCheckinStatus(token: string): Promise<
      { active: boolean; todayCheckedIn: boolean; streakDays: number } | undefined
    > {
      const urls = p.checkinStatusUrls
      if (urls === undefined) return undefined
      const resp = await fetchWithFallback(
        urls,
        {
          method: 'POST',
          headers: p.headers(token, { 'Content-Type': 'application/json' }),
          body: '{}',
          signal: AbortSignal.timeout(20000),
        },
        [404],
      )
      const j = (await resp.json()) as { code?: number; data?: Record<string, unknown> }
      if (!resp.ok || j.code !== 0 || j.data === undefined || j.data === null) return undefined
      return {
        active: j.data.active === true,
        todayCheckedIn: j.data.today_checked_in === true,
        streakDays: typeof j.data.streak_days === 'number' ? j.data.streak_days : 0,
      }
    }

    /**
     * 单账号签到：预读状态 → 必要时才签发（幂等，已签到 10001 也视为成功）。
     *
     * 为什么现在**预读**（2026-10-28 改，此前是「直接签、靠 10001 幂等」）：
     * 直接签在国际侧是把一次写请求打在一个**没开活动**的区上，拿回来的错说不清
     * 是什么（没有 active 判据就分不出「今天签过了」和「这个区不办这活动」）。
     * 预读只多一次读请求，换来的是三种形态各自有明确答复：
     *   active=false          → 「该区域未开放签到活动」（**不发写请求**）
     *   today_checked_in=true → 「今日已签到」（**不发写请求**）+ 刷新积分
     *   其余                   → 签发
     * 预读失败一律 fail-open：读不到状态就照旧直接签（不能因为读接口坏了就签不了）。
     */
    async function checkinOne(uid: string): Promise<{ uid: string; ok: boolean; status: string; message?: string }> {
      const cred = getCred(uid)
      if (!cred) return { uid, ok: false, status: 'error', message: '凭证缺失' }
      let token: string
      try {
        token = (await refreshIfNeeded(uid, cred)).accessToken
      } catch {
        token = cred.accessToken
      }
      try {
        const state = await fetchCheckinStatus(token).catch(() => undefined)
        if (state !== undefined) {
          if (!state.active) {
            return { uid, ok: false, status: 'error', message: '该区域未开放签到活动' }
          }
          if (state.todayCheckedIn) {
            // 已签到也刷新积分：用户点签到就是想看当前额度，不该拿 10 分钟前的旧值
            await refreshCredits(uid)
            return {
              uid,
              ok: true,
              status: 'already',
              message: state.streakDays > 0 ? `今日已签到（连续 ${state.streakDays} 天）` : '今日已签到',
            }
          }
        }
        const resp = await fetchWithFallback(
          p.checkinUrls,
          {
            method: 'POST',
            headers: p.headers(token, { 'Content-Type': 'application/json' }),
            body: '{}',
            signal: AbortSignal.timeout(20000),
          },
          [404],
        )
        // 已签到时上游返回 HTTP 400 + code=10001（幂等），故先解析 body 的 code 再判状态
        let j: { code?: number; msg?: string; data?: { credit?: number; streak_days?: number } } | undefined
        try {
          j = (await resp.json()) as typeof j
        } catch {
          // 非 JSON（如 WAF/网关 HTML）
        }
        if (j?.code === ALREADY_CHECKED_IN_CODE) {
          await refreshCredits(uid)
          return { uid, ok: true, status: 'already', message: j.msg ?? '今日已签到' }
        }
        if (j !== undefined && j.code !== undefined && j.code !== 0) {
          return { uid, ok: false, status: 'error', message: j.msg ?? `签到失败 code=${String(j.code)}` }
        }
        if (!resp.ok) {
          // 401/403 = 凭证失效。签到请求体固定 '{}'、无用户内容，不会触发 WAF
          // 拦截（chatOnce 的 403 非 JSON 是请求级拦截，见下方分类）。冷却/禁用
          // 是核心的活，这里只报事实：核心下次请求时该号会按 session_dead 被禁用。
          if (resp.status === 401 || resp.status === 403) {
            return { uid, ok: false, status: 'error', message: `凭证失效 ${resp.status}` }
          }
          return { uid, ok: false, status: 'error', message: `签到失败 ${resp.status}` }
        }
        await refreshCredits(uid) // 签到后积分变化，刷新缓存
        const days = j?.data?.streak_days
        return {
          uid,
          ok: true,
          status: 'ok',
          message: `+${j?.data?.credit ?? 0} 积分${typeof days === 'number' ? `（连续 ${days} 天）` : ''}`,
        }
      } catch (err) {
        return { uid, ok: false, status: 'error', message: (err as Error).message }
      }
    }

    /** 刷新 token（若临近过期）。返回新 cred 或原样。 */
    async function refreshIfNeeded(uid: string, cred: CodeBuddyCred): Promise<CodeBuddyCred> {
      // 触发刷新：临到期（剩 24h 内）**或**签发超过 15 天（主动轮换保新鲜）。
      // iat 解不出来时只按临到期判（回落到旧行为）；只要满足其一就刷。
      const iat = tokenIssuedAtMs(cred.accessToken)
      const issuedLongAgo = iat !== null && Date.now() - iat >= REFRESH_MAX_ISSUED_MS
      if (!issuedLongAgo && Date.now() + REFRESH_SKEW_MS < cred.expiresAt) return cred
      if (!cred.refreshToken) return cred
      try {
        const resp = await fetch(p.refreshUrl, {
          method: 'POST',
          headers: p.headers(undefined, {
            'X-Refresh-Token': cred.refreshToken,
            'X-Auth-Refresh-Source': 'plugin',
            'X-Domain': p.domain,
          }),
          body: '{}',
          signal: AbortSignal.timeout(20000),
        })
        if (!resp.ok) return cred
        const data = (await resp.json()) as { code?: number; data?: { accessToken?: string; refreshToken?: string; expiresIn?: number } }
        if (data.code !== 0 || !data.data?.accessToken) return cred
        const next: CodeBuddyCred = {
          nickname: cred.nickname,
          accessToken: data.data.accessToken,
          refreshToken: data.data.refreshToken || cred.refreshToken,
          expiresAt: Date.now() + (data.data.expiresIn || 86400) * 1000,
        }
        creds.save(id, uid, next)
        log(`${p.errPrefix} token refreshed ${uid}`)
        return next
      } catch {
        return cred
      }
    }

    return {
      id,
      name: p.name,
      priority: p.priority,
      icon: p.icon,
      status: (): SupplierStatusNow => {
        const now = Date.now()
        // 只报「现在状态」：凭证是否存在 + 积分。冷却/禁用/错误累计由核心叠加。
        const accounts = orderedUids().map((uid) => {
          const cred = getCred(uid)
          // 积分读缓存（同步）；过期则后台异步刷新，下次刷新面板即显示新值
          const cached = creditsCache.get(uid)
          if (cached === undefined || now - cached.at > CREDITS_TTL_MS) void refreshCredits(uid)
          return {
            uid,
            nickname: cred?.nickname || p.defaultNickname,
            // 没缓存过就报 -1（不是 0）：核心拿它区分「没拿到」与「拿到了 0」，
            // 从而保留上次持久化的积分
            credits: cached?.value ?? CREDITS_UNKNOWN,
            state: (cred === undefined ? 'session_dead' : 'ok') as AccountState,
          }
        })
        return { id, name: p.name, accounts }
      },
      /** 签到：单账号（核心遍历所有链接 + 汇总），每日 100 积分（连续 7 天 1000）。 */
      checkinNow: async (uid: string): Promise<{ ok: boolean; status: string; message?: string }> => {
        const r = await checkinOne(uid)
        log(`${p.errPrefix} checkin ${uid}: ${r.status}${r.message === undefined ? '' : ` (${r.message})`}`)
        return r
      },
      /** 从上游 config 端点拉模型（force=true 由「获取模型」按钮触发）。 */
      listModels: (force?: boolean): Promise<ModelInfo[]> => allModels(!!force),
      /** OAuth 轮询登录：POST state → 返回 authUrl（浏览器打开），后台轮询 token。 */
      generateLoginUrl: async (): Promise<{ ok: boolean; error?: string; loginUrl?: string }> => {
        try {
          const resp = await fetch(`${p.stateUrl}?platform=CLI`, {
            method: 'POST',
            headers: p.headers(undefined, {
              'X-Domain': p.domain,
              'X-No-Authorization': 'true',
              'X-No-User-Id': 'true',
            }),
            body: '{}',
            signal: AbortSignal.timeout(20000),
          })
          if (!resp.ok) return { ok: false, error: `${p.errPrefix} state failed: ${resp.status}` }
          const data = (await resp.json()) as { code?: number; msg?: string; data?: { state?: string; authUrl?: string } }
          if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
            return { ok: false, error: `${p.errPrefix} state error: ${data.msg || 'missing state'}` }
          }
          pendingState = data.data.state
          // uid 在拿到 token 后才能确定；先占位，轮询成功后按返回的账号信息生成
          pendingUid = undefined
          log(`${p.errPrefix} login started, awaiting browser auth`)
          return { ok: true, loginUrl: data.data.authUrl }
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      },
      pollLogin: (): boolean => true,
      /** 轮询 token（忽略传入的 callbackUrl）。返回账号或抛错。 */
      completeLogin: async (): Promise<{ uid: string; nickname: string }> => {
        const state = pendingState
        if (!state) throw new Error('请先生成登录链接')
        const deadline = Date.now() + POLL_TIMEOUT_MS
        for (;;) {
          if (Date.now() > deadline) {
            pendingState = undefined
            throw new Error('登录超时，请重试')
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          let data: { code?: number; msg?: string; data?: { accessToken?: string; refreshToken?: string; expiresIn?: number } }
          try {
            const resp = await fetch(`${p.tokenUrl}?state=${encodeURIComponent(state)}`, {
              method: 'GET',
              headers: p.headers(undefined, {
                'X-Domain': p.domain,
                'X-No-Authorization': 'true',
                'X-No-User-Id': 'true',
                'X-No-Enterprise-Id': 'true',
                'X-No-Department-Info': 'true',
              }),
              signal: AbortSignal.timeout(15000),
            })
            if (!resp.ok) continue
            data = (await resp.json()) as typeof data
          } catch {
            continue
          }
          if (data.code === 11217) continue // pending
          if (data.code !== 0 || !data.data?.accessToken) {
            pendingState = undefined
            throw new Error(data.msg || '登录失败')
          }
          // 成功：落盘账号
          const nickname = p.defaultNickname
          let n = listUids().length + 1
          let uid = `${p.uidPrefix}-${n}`
          while (getCred(uid) !== undefined) uid = `${p.uidPrefix}-${++n}`
          const cred: CodeBuddyCred = {
            nickname,
            accessToken: data.data.accessToken,
            refreshToken: data.data.refreshToken || '',
            expiresAt: Date.now() + (data.data.expiresIn || 86400) * 1000,
          }
          creds.save(id, uid, cred)
          pendingState = undefined
          log(`${p.errPrefix} login ok ${uid}`)
          return { uid, nickname }
        }
      },
      removeLink: (uid: string): Promise<boolean> => {
        if (getCred(uid) === undefined) return Promise.resolve(false)
        creds.remove(id, uid)
        return Promise.resolve(true)
      },
      /** 对单个账号调一次上游。选号/冷却/换号是核心的活，这里只报结果。 */
      async chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> {
        const base = stripAlias(req.model, currentAlias())
        if (base === '') {
          const msg = `unknown model ${JSON.stringify(req.model)}`
          return { ok: false, state: 'no_such_model', message: msg }
        }
        const cred = getCred(uid)
        if (cred === undefined) {
          const msg = `unknown account ${JSON.stringify(uid)}`
          return { ok: false, state: 'no_such_model', message: msg }
        }

        // 上游只支持流式：非流式请求也强制 stream:true（9router 同）
        let body = req.rawBody
        try {
          const obj = JSON.parse(body) as Record<string, unknown>
          obj.model = base
          obj.stream = true
          // 推理等级：上游要同时收到 reasoning_effort + reasoning_summary
          // 才吐推理内容（9router #2071：无条件加会触发内容过滤）。auto/off 显式删字段。
          if (lv !== 'auto' && lv !== '' && lv !== 'none' && lv !== 'off') {
            obj.reasoning_effort = lv
            obj.reasoning_summary = 'auto'
          } else {
            delete obj.reasoning_effort
            delete obj.reasoning_summary
          }
          p.normalizeBody?.(obj)
          body = JSON.stringify(obj)
          // 串行两步：先字段级归一，再整体文本归一（见 profile 注释）
          if (p.normalizeBodyText !== undefined) body = p.normalizeBodyText(body)
        } catch {
          // 保持原样
        }

        // 刷新失败继续用旧 token（token 过期由上游返回码体现）
        let fresh = cred
        try {
          fresh = await refreshIfNeeded(uid, cred)
        } catch {
          // 保持原样
        }

        // 超时只守「连接 + 响应头」：AbortSignal.timeout 会连 body 流一起封顶，
        // 长生成超 120s 时流被中途 abort，客户端看到回复写一半就断。
        // 改成计时器：响应头到手即撤表，生成时长不限。
        //
        // body 停摆**不由插件管**：响应头一到流就交回核心了，插件没有「换号/
        // 换模型」的能力，自己再套一层 body 超时只会把失败提前锁死在一条腿上。
        // 核心那道闸门是 `FIRST_BYTE_BUDGET_MS`（每条降级腿 60s 首字节预算），
        // 见 dsh-router docs/suppliers.md「首字节预算」。
        //
        // 端点候选：仅 404/405 换下一个（上游新旧路径分叉），其余状态码直接返回。
        //
        // 11128 重试阶梯（2026-10-28，对齐 dsh-connect-workbuddy 的实测结论）：
        // 渠道闸按**请求内容**拒绝，同一个 body 换号、换端点结果都一样，所以它
        // 不是换号能解决的事，只能改请求本身。三级、逐级只在**真改了字节**时才发：
        //   1. 原样（绝大多数请求走到这里就结束）
        //   2. 强制中性头：把被禁的开场白挪到 `You are a helpful assistant.` 之后
        //   3. 零宽散点：在句读/词边界插 U+200B，打断「精确子串」指纹
        // 三级都在同一个号上跑（闸读的是请求不是账号），失败才报 bad_request 让
        // 核心换下一个供应商——那一步才是「换号」该发生的地方。
        const attempts: string[] = [body]
        const forced = forceNeutralHead(body)
        if (forced !== undefined) attempts.push(forced)
        const perturbed = perturbChannelFingerprints(forced ?? body)
        if (perturbed !== undefined) attempts.push(perturbed)
        const attemptName = ['plain', 'forced neutral head', 'invisible perturbation'] as const

        // 会话身份三连：官方客户端每请求必带（缺了就是 11128「不是官方客户端」）。
        const identityHeaders = conversationIdHeaders()
        let upstream: Response | undefined
        let lastStatus = 0
        let lastText = ''
        for (let a = 0; a < attempts.length && a < CHAT_ATTEMPT_LIMIT; a++) {
          const sent = attempts[a]!
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(new Error('upstream connect/response timeout (120s)')), 120_000)
          let resp: Response | undefined
          try {
            for (let i = 0; i < p.chatUrls.length; i++) {
              try {
                resp = await fetch(p.chatUrls[i]!, {
                  method: 'POST',
                  headers: p.headers(fresh.accessToken, {
                    'Content-Type': 'application/json',
                    ...p.chatExtraHeaders,
                    ...identityHeaders,
                  }),
                  body: sent,
                  signal: ctrl.signal,
                })
                if (i < p.chatUrls.length - 1 && (resp.status === 404 || resp.status === 405)) continue
                break
              } catch (err) {
                if (i < p.chatUrls.length - 1) continue
                throw err
              }
            }
          } catch (err) {
            const msg = (err as Error).message
            return { ok: false, state: 'transport', message: msg }
          } finally {
            clearTimeout(timer)
          }
          if (resp === undefined) {
            return { ok: false, state: 'transport', message: 'no chat endpoint' }
          }
          if (resp.status >= 200 && resp.status < 300) {
            upstream = resp
            break
          }
          lastStatus = resp.status
          lastText = await resp.text().catch(() => '')
          // 只有「渠道闸拒绝」值得改请求重试；其余错误原样交回核心判定
          const retriable = isChannelRejectBody(lastText)
            && a + 1 < attempts.length
            && a + 1 < CHAT_ATTEMPT_LIMIT
            && lastStatus !== 429
          if (!retriable) break
          log(`${p.errPrefix} 11128 channel gate refused (${attemptName[a] ?? String(a)}); retrying as ${attemptName[a + 1] ?? 'next form'}`)
        }
        if (upstream === undefined) {
          const text = lastText
          const gwErr = gatewayError(p.errPrefix, text, lastStatus)
          // 上游网关错误常是 HTTP 400 包一个语义 code（如 11133 请求参数非法、
          // 11134 模型提供方临时不可用）。HTTP 状态只够粗分，这几个网关 code
          // 得单独认——否则一律归 `unknown` 计连续错误，攒够 3 次就把整个池
          // 冷却掉（今日 10min 断流正是这么来的）。
          //
          // 2026-09-15 追加：**请求本身非法**（`extError.type =
          // invalid_request_error`，如 11133 参数不符 / 11135 图片认不出 /
          // 11148 tool_call 配对断裂）不是账号的错——同一个请求对池里每个号
          // 都会失败。归 rate_limit 冷号会把「这条请求有问题」放大成「这个
          // 模型 30 秒内谁都别用」，组合两条腿同时被冷就是全灭 503 的成因。
          // 所以这类报 `bad_request`（核心不惩罚账号，直接换下一个）。
          let gwCode: number | undefined
          let extType: string | undefined
          let isJsonBody = false
          try {
            const j = JSON.parse(text) as { code?: number; extError?: { type?: string } }
            isJsonBody = true
            gwCode = typeof j.code === 'number' ? j.code : undefined
            extType = typeof j.extError?.type === 'string' ? j.extError.type : undefined
          } catch {
            // 非 JSON：靠 HTTP 状态分类
          }
          // 明确认得的 code 优先（如 11134 是上游临时不可用，仍走 rate_limit
          // 短冷换号）；两家里未枚举的新 code 才落到 extError.type 兜底。
          //
          // 注意这里的顺序**只处理认得的业务 code**：它们都随 400/500 到达，
          // 本就会落到 `byCode`。**不要**把 byCode 提到 HTTP 状态之前——那会让
          // 「403/429 + 某个请求级 code」变成跳过整个供应商，从而失去换号。
          // 已实测的反例：11140 随 403 到达且**是账号级**的（同一 token 在同一
          // host 上能读 /v3/config，同请求换 wb-2/wb-3 就成功），故必须留在
          // session_dead 上按连接级冷却 + 换号，而不是 bad_request。
          //
          // 403 再按 body 形态二分（issue #3，2026-10-16）：业务风控（11140 等）
          // 是 **JSON**，账号级 → session_dead；前置 WAF/网关拦截（WAF Block Page）
          // 是 **HTML**，请求级 —— 同一 body 对每个号都一样 403（WAF 在鉴权前判
          // 定，假 token 与真 token 结果一致），归 bad_request 不惩罚账号。
          // 否则一次 WAF 误判 = 该号 session_dead 冷 30 分钟，单号池直接 503 全灭。
          //
          // 11128（渠道闸）另算：它**先于** HTTP 状态判定（2026-10-28）。理由与
          // 上一条相反：闸读的是请求内容，同一 body 对每个号、每个端点结果相同，
          // 所以它必须归 bad_request —— 让核心跳过本供应商，而不是把这个号的
          // session 判死。重试阶梯已经试过三种形态，仍被拒说明这份内容本身就过
          // 不去，换号无济于事。
          const channelReject = isChannelRejectBody(text)
          const byCode = gwCode === undefined ? undefined : p.classifyGatewayCode?.(gwCode)
          const state: AccountState =
            lastStatus === 429 ? 'rate_limit'
              : channelReject ? 'bad_request'
                : lastStatus === 401 || (lastStatus === 403 && isJsonBody) ? 'session_dead'
                  : lastStatus === 403 ? 'bad_request'
                    : lastStatus === 404 ? 'unavailable'
                      : byCode ?? (extType === 'invalid_request_error' ? 'bad_request' : 'unknown')
          // 限流文案自带重置时刻（6004「将在 … 重置」）→ 交给核心冷到那个点
          const resetAt = state === 'rate_limit' ? resetAtOf(text) : undefined
          return { ok: false, state, message: gwErr, ...(resetAt === undefined ? {} : { resetAt }) }
        }
        // 上游恒为流式：原样交回核心写
        if (!upstream.body) {
          const msg = `${p.errPrefix} upstream: empty stream body`
          return { ok: false, state: 'transport', message: msg }
        }
        return { ok: true, stream: upstream.body }
      },
      dispose: (): void => {
        creditsCache.clear()
        creditsInflight.clear()
        modelsCache = undefined
      },
    }
  }
}
