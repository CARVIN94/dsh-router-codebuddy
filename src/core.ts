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
  /** billing/meter 签到端点候选（同上）。 */
  checkinUrls: string[]
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
/** 周期结束距资源到期 >2 天 = 会续期的基础包(Refill)，否则是一次性赠送包(Bonus)。 */
const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000
/** 非聊天模型（生图/视频等）：网关 chat 端点不支持，面板不该出现。 */
const NON_CHAT_TAGS = /text-to-image|image-to-image|text-to-video|image-to-video/i

/** 取数值：优先 Precise 字符串字段（精确），回落到数字字段。 */
function precise(preciseValue: unknown, plain: unknown): number {
  const n = Number(preciseValue ?? plain)
  return Number.isFinite(n) ? n : 0
}

interface CodeBuddyCred {
  nickname: string
  accessToken: string
  refreshToken: string
  expiresAt: number // ms epoch
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

    /** 拉取某账号剩余积分（get-user-resource 的包 CapacityRemain 求和），更新缓存。
     *  注意：TotalDosage 是「累计已消耗」，不是剩余额度（踩过）。
     *  Refill 包（基础体验包，周期续期）看 Cycle 字段，Bonus 包（一次性赠送）看 plain 字段。 */
    async function refreshCredits(uid: string): Promise<number | undefined> {
      if (creditsInflight.has(uid)) return undefined
      creditsInflight.add(uid)
      try {
        return await fetchCredits(uid)
      } finally {
        creditsInflight.delete(uid)
      }
    }

    async function fetchCredits(uid: string): Promise<number | undefined> {
      const cred = getCred(uid)
      if (!cred) return undefined
      try {
        const fresh = await refreshIfNeeded(uid, cred)
        const resp = await fetchWithFallback(
          p.usageUrls,
          {
            method: 'POST',
            headers: p.headers(fresh.accessToken, { 'Content-Type': 'application/json' }),
            body: '{}',
            signal: AbortSignal.timeout(20000),
          },
          [404],
        )
        const j = (await resp.json()) as {
          code?: number
          data?: { Response?: { Data?: { Accounts?: Array<Record<string, unknown>> } } }
        }
        const accounts = j.data?.Response?.Data?.Accounts
        if (resp.ok && j.code === 0 && Array.isArray(accounts)) {
          let remain = 0
          for (const a of accounts) {
            const cycleEnd = typeof a.CycleEndTime === 'string' ? Date.parse(a.CycleEndTime) : Number.NaN
            const deductionEnd = Number(a.DeductionEndTime)
            // 周期结束远早于资源到期 = 会续期的基础包，其余是一次性赠送包
            const isRefill = Number.isFinite(cycleEnd) && Number.isFinite(deductionEnd) && deductionEnd - cycleEnd > REFILL_GAP_MS
            remain += isRefill
              ? precise(a.CycleCapacityRemainPrecise, a.CycleCapacityRemain)
              : precise(a.CapacityRemainPrecise, a.CapacityRemain)
          }
          const value = Math.round(remain * 100) / 100
          creditsCache.set(uid, { value, at: Date.now() })
          return value
        }
      } catch {
        // 积分拉取失败不阻塞主流程
      }
      return undefined
    }

    /** 单账号签到：直接签到（幂等：已签到返回 10001），成功后刷新积分缓存。
     *  实测 checkin-status 的 today_checked_in 恒为 false（活动字段不可靠），故不预查状态。 */
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
          // 已签到也刷新积分：用户点签到就是想看当前额度，不该拿 10 分钟前的旧值
          await refreshCredits(uid)
          return { uid, ok: true, status: 'already', message: j.msg ?? '今日已签到' }
        }
        if (j !== undefined && j.code !== undefined && j.code !== 0) {
          return { uid, ok: false, status: 'error', message: j.msg ?? `签到失败 code=${String(j.code)}` }
        }
        if (!resp.ok) {
          // 401/403 = 凭证失效（非 JSON 网关拦截也算）。冷却/禁用是核心的活，
          // 这里只报事实：核心下次请求时该号会按 session_dead 被禁用。
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
      if (Date.now() + REFRESH_SKEW_MS < cred.expiresAt) return cred
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
        // ponytail: 若上游接上后 body 中途停摆，现在没有任何超时会杀它，
        // 响应会挂到客户端自己断开为止；要防这种，得在流上做空闲超时。
        //
        // 端点候选：仅 404/405 换下一个（上游新旧路径分叉），其余状态码直接返回。
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(new Error('upstream connect/response timeout (120s)')), 120_000)
        let upstream: Response | undefined
        for (let i = 0; i < p.chatUrls.length; i++) {
          try {
            upstream = await fetch(p.chatUrls[i]!, {
              method: 'POST',
              headers: p.headers(fresh.accessToken, {
                'Content-Type': 'application/json',
                ...p.chatExtraHeaders,
              }),
              body,
              signal: ctrl.signal,
            })
            if (i < p.chatUrls.length - 1 && (upstream.status === 404 || upstream.status === 405)) continue
            break
          } catch (err) {
            if (i < p.chatUrls.length - 1) continue
            clearTimeout(timer)
            const msg = (err as Error).message
            return { ok: false, state: 'transport', message: msg }
          }
        }
        clearTimeout(timer)
        if (upstream === undefined) {
          return { ok: false, state: 'transport', message: 'no chat endpoint' }
        }
        if (upstream.status < 200 || upstream.status >= 300) {
          const text = await upstream.text().catch(() => '')
          const gwErr = gatewayError(p.errPrefix, text, upstream.status)
          // 上游网关错误常是 HTTP 400 包一个语义 code（如 11133 请求参数非法、
          // 11134 模型提供方临时不可用）。HTTP 状态只够粗分，这几个网关 code
          // 得单独认——否则一律归 `unknown` 计连续错误，攒够 3 次就把整个池
          // 冷却掉（今日 10min 断流正是这么来的）。
          let gwCode: number | undefined
          try {
            const j = JSON.parse(text) as { code?: number }
            gwCode = typeof j.code === 'number' ? j.code : undefined
          } catch {
            // 非 JSON：靠 HTTP 状态分类
          }
          const state: AccountState =
            upstream.status === 429 ? 'rate_limit'
              : upstream.status === 401 || upstream.status === 403 ? 'session_dead'
                : upstream.status === 404 ? 'unavailable'
                  : (gwCode === undefined ? undefined : p.classifyGatewayCode?.(gwCode)) ?? 'unknown'
          return { ok: false, state, message: gwErr }
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
