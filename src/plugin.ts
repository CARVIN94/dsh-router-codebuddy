/**
 * codebuddy 供应商插件 —— 参考 9Router(open-sse) 的 codebuddy-cn 实现。
 *
 * 上游：https://copilot.tencent.com（腾讯 CodeBuddy，OpenAI 兼容网关）
 *   - chat:   POST /v2/chat/completions（强制流式；非流式上游 400 拒绝）
 *   - login:  OAuth 轮询：POST /v2/plugin/auth/state → 浏览器打开 authUrl →
 *             轮询 GET /v2/plugin/auth/token?state=... 直到 code 0（accessToken）
 *   - refresh:POST /v2/plugin/auth/token/refresh（X-Refresh-Token 头）
 *
 * OAuth 账号：走「添加链接 + 连接池」（同 traework），凭证存通用
 * CredentialStore（auths/codebuddy/{uid}.json，{ nickname, accessToken,
 * refreshToken, expiresAt }）。模型固定列表（同 9router codebuddy-cn）。
 */
import type { ChatRequest, ModelInfo } from './types.ts'
import type { AccountState, ChatOnceResult, SupplierEnv, SupplierModule, SupplierStatusNow } from './contract.ts'

export const id = 'codebuddy'
export const name = 'CodeBuddy'
export const priority = 90 // 同 9router：非免费直连，排在后面
/**
 * 面板图标（CodeBuddy 官方 logo，128×128 PNG，base64 内联）。
 *
 * **必须内联，不能放网络 URL**：之前是 `http://localhost:20128/...`（9router
 * 的端口），9router 没跑时就是一张坏图 —— 面板图标不该依赖另一个服务活着，
 * 更不该依赖特定端口。
 */
export const icon = 'data:image/png;base64,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'

const BASE = 'https://copilot.tencent.com'
const CHAT_URL = `${BASE}/v2/chat/completions`
const STATE_URL = `${BASE}/v2/plugin/auth/state`
const TOKEN_URL = `${BASE}/v2/plugin/auth/token`
const REFRESH_URL = `${BASE}/v2/plugin/auth/token/refresh`
const UA = 'CLI/2.108.1 CodeBuddy/2.108.1'
const POLL_INTERVAL_MS = 5000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
/** 默认前缀（用户可在面板改；loader 包装会优先用 store 里的值）。 */
const REFRESH_SKEW_MS = 24 * 3600_000 // 到期前 24 小时内刷新（同 traework）

// 签到与积分（实测：POST body '{}'，Bearer accessToken）
// 注：checkin-status 的 today_checked_in/total_credits 恒为 false/0（活动字段不可靠），
//     故「是否可签到」靠 daily-checkin 幂等返回判断，积分取 get-user-resource 的 TotalDosage。
const USAGE_URL = `${BASE}/v2/billing/meter/get-user-resource`
const DAILY_CHECKIN_URL = `${BASE}/billing/meter/daily-checkin`
/** 今日已签到（幂等，视为成功）。 */
const ALREADY_CHECKED_IN_CODE = 10001
const CREDITS_TTL_MS = 10 * 60 * 1000 // 积分缓存 10 分钟
/** 周期结束距资源到期 >2 天 = 会续期的基础包(Refill)，否则是一次性赠送包(Bonus)。 */
const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000

/** 取数值：优先 Precise 字符串字段（精确），回落到数字字段。 */
function precise(preciseValue: unknown, plain: unknown): number {
  const n = Number(preciseValue ?? plain)
  return Number.isFinite(n) ? n : 0
}

/** 模型来源：CodeBuddy 上游无公开 models 接口（copilot.tencent.com 不暴露），
 * 内置模型列表来自 WorkBuddy.app（CodeBuddy 官方桌面客户端）的 product.json +
 * 9router 实际使用记录（hy4/hy4-preview 由服务器下发，本地 product.json 没有）。
 * 只保留各系列最新版本（v4 / 5.2 / M3 / K2.7 / Hy4 / Hunyuan-2.0）。
 * 用户在面板仍可添加自定义模型。 */
const BUILTIN_MODELS: ModelInfo[] = [
  { id: 'deepseek-v4-pro', context_length: 1000000 },
  { id: 'deepseek-v4-flash', context_length: 1000000 },
  { id: 'glm-5.2', context_length: 200000 },
  { id: 'minimax-m3-play', context_length: 512000 },
  { id: 'kimi-k2.7-code', context_length: 256000 },
  { id: 'hy4-preview', context_length: 192000 },
  { id: 'hy4', context_length: 192000 },
  { id: 'hy3-preview', context_length: 192000 },
  { id: 'hunyuan-2.0-thinking', context_length: 128000 },
]

interface CodeBuddyCred {
  nickname: string
  accessToken: string
  refreshToken: string
  expiresAt: number // ms epoch
}

/** 请求头（同 9router codebuddy-cn transport.headers + auth bearer）。 */
function headers(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': UA,
    'X-Product': 'SaaS',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'x-requested-with': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
    ...extra,
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/** 腾讯网关错误：code 非 0 时提取 msg。 */
function gatewayError(body: string, status: number): string {
  try {
    const j = JSON.parse(body) as { code?: number; msg?: string; message?: string }
    if (j.code && j.code !== 0) return `codebuddy ${j.code}: ${j.msg || j.message || ''}`.trim()
    if (j.message) return `codebuddy ${status}: ${j.message}`
  } catch {
    // 非 JSON
  }
  return `upstream ${status}: ${body.slice(0, 200)}`
}


/** 剥 alias 前缀（cbcn/glm-5.2 → glm-5.2）。 */
/** 剥本供应商 alias 前缀（只剥自己的，模型 id 自带的斜杠保留，否则自定义模型
 *  `org/name` 会被剥成 `name`，请求必然 404）。 */
function stripAlias(model: string, alias: string): string {
  return alias !== '' && model.startsWith(`${alias}/`) ? model.slice(alias.length + 1) : model
}

export default function factory(env: SupplierEnv): SupplierModule {
  const creds = env.credentials
  const store = env.store
  const log = env.log

  /** 进行中的登录 state。 */
  let pendingState: string | undefined
  let pendingUid: string | undefined

  /** 上次 chatOnce 失败原因（供核心测试模型汇总诊断）。 */
  let lastErr: string | undefined
  /** 积分缓存：uid → { value, at }（status() 同步返回，过期后台异步刷新）。 */
  const creditsCache = new Map<string, { value: number; at: number }>()

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


  /** 拉取某账号剩余积分（get-user-resource 的包 CapacityRemain 求和），更新缓存。
   *  注意：TotalDosage 是「累计已消耗」，不是剩余额度（踩过）。
   *  Refill 包（基础体验包，周期续期）看 Cycle 字段，Bonus 包（一次性赠送）看 plain 字段。 */
  async function refreshCredits(uid: string): Promise<number | undefined> {
    const cred = getCred(uid)
    if (!cred) return undefined
    try {
      const fresh = await refreshIfNeeded(uid, cred)
      const resp = await fetch(USAGE_URL, {
        method: 'POST',
        headers: headers(fresh.accessToken, { 'Content-Type': 'application/json' }),
        body: '{}',
        signal: AbortSignal.timeout(20000),
      })
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
      const resp = await fetch(DAILY_CHECKIN_URL, {
        method: 'POST',
        headers: headers(token, { 'Content-Type': 'application/json' }),
        body: '{}',
        signal: AbortSignal.timeout(20000),
      })
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
      const resp = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: headers(undefined, {
          'X-Refresh-Token': cred.refreshToken,
          'X-Auth-Refresh-Source': 'plugin',
          'X-Domain': 'copilot.tencent.com',
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
      log(`codebuddy token refreshed ${uid}`)
      return next
    } catch {
      return cred
    }
  }

  return {
    id,
    name,
    priority,
    icon,
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
          nickname: cred?.nickname || 'CodeBuddy',
          credits: cached?.value ?? 0,
          state: (cred === undefined ? 'session_dead' : 'ok') as AccountState,
        }
      })
      return { id, name, accounts }
    },
    /** 签到：单账号（核心遍历所有链接 + 汇总），每日 100 积分（连续 7 天 1000）。 */
    checkinNow: async (uid: string): Promise<{ ok: boolean; status: string; message?: string }> => {
      const r = await checkinOne(uid)
      log(`codebuddy checkin ${uid}: ${r.status}${r.message === undefined ? '' : ` (${r.message})`}`)
      return r
    },
    listModels: (): ModelInfo[] => BUILTIN_MODELS, // 内置模型列表(来自 WorkBuddy.app product.json),用户仍可自定义
    getAlias: (): string => id,
    /** OAuth 轮询登录：POST state → 返回 authUrl（浏览器打开），后台轮询 token。 */
    generateLoginUrl: async (): Promise<{ ok: boolean; error?: string; loginUrl?: string }> => {
      try {
        const resp = await fetch(`${STATE_URL}?platform=CLI`, {
          method: 'POST',
          headers: headers(undefined, {
            'X-Domain': 'copilot.tencent.com',
            'X-No-Authorization': 'true',
            'X-No-User-Id': 'true',
          }),
          body: '{}',
          signal: AbortSignal.timeout(20000),
        })
        if (!resp.ok) return { ok: false, error: `codebuddy state failed: ${resp.status}` }
        const data = (await resp.json()) as { code?: number; msg?: string; data?: { state?: string; authUrl?: string } }
        if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
          return { ok: false, error: `codebuddy state error: ${data.msg || 'missing state'}` }
        }
        pendingState = data.data.state
        // uid 在拿到 token 后才能确定；先占位，轮询成功后按返回的账号信息生成
        pendingUid = undefined
        log('codebuddy login started, awaiting browser auth')
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
          const resp = await fetch(`${TOKEN_URL}?state=${encodeURIComponent(state)}`, {
            method: 'GET',
            headers: headers(undefined, {
              'X-Domain': 'copilot.tencent.com',
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
        const nickname = 'CodeBuddy'
        let n = listUids().length + 1
        let uid = `cb-${n}`
        while (getCred(uid) !== undefined) uid = `cb-${++n}`
        const cred: CodeBuddyCred = {
          nickname,
          accessToken: data.data.accessToken,
          refreshToken: data.data.refreshToken || '',
          expiresAt: Date.now() + (data.data.expiresIn || 86400) * 1000,
        }
        creds.save(id, uid, cred)
        pendingState = undefined
        log(`codebuddy login ok ${uid}`)
        return { uid, nickname }
      }
    },
    removeLink: (uid: string): Promise<boolean> => {
      if (getCred(uid) === undefined) return Promise.resolve(false)
      creds.remove(id, uid)
      return Promise.resolve(true)
    },
    lastError: (): string | undefined => lastErr,
    /** 对单个账号调一次上游。选号/冷却/换号是核心的活，这里只报结果。 */
    async chatOnce(uid: string, req: ChatRequest): Promise<ChatOnceResult> {
      const base = stripAlias(req.model, currentAlias())
      if (base === '') {
        lastErr = `unknown model ${JSON.stringify(req.model)}`
        return { ok: false, state: 'no_such_model', message: lastErr }
      }
      const cred = getCred(uid)
      if (cred === undefined) {
        lastErr = `unknown account ${JSON.stringify(uid)}`
        return { ok: false, state: 'no_such_model', message: lastErr }
      }

      // CodeBuddy 只支持流式：非流式请求也强制 stream:true（9router 同）
      let body = req.rawBody
      try {
        const obj = JSON.parse(body) as Record<string, unknown>
        obj.model = base
        obj.stream = true
        body = JSON.stringify(obj)
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

      let upstream: Response
      try {
        upstream = await fetch(CHAT_URL, {
          method: 'POST',
          headers: headers(fresh.accessToken, { 'Content-Type': 'application/json' }),
          body,
          signal: AbortSignal.timeout(120000),
        })
      } catch (err) {
        lastErr = (err as Error).message
        return { ok: false, state: 'transport', message: lastErr }
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        const text = await upstream.text().catch(() => '')
        lastErr = gatewayError(text, upstream.status)
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
                // 11133（请求参数非法）/11134（上游临时不可用）都是瞬时/请求类，
                // 归 rate_limit = 单号短冷却换号，别攒错误把整个池打垮。
                : gwCode === 11133 || gwCode === 11134 ? 'rate_limit'
                  : 'unknown'
        return { ok: false, state, message: lastErr }
      }
      // 上游恒为流式：原样交回核心写
      if (!upstream.body) {
        lastErr = 'codebuddy upstream: empty stream body'
        return { ok: false, state: 'transport', message: lastErr }
      }
      return { ok: true, stream: upstream.body }
    },
    dispose: (): void => {
      creditsCache.clear()
    },
  }
}
