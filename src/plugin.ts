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
/** 面板图标（9router 提供的 codebuddy logo：http://localhost:20128/providers/codebuddy-cn.png）。 */
export const icon = 'http://localhost:20128/providers/codebuddy-cn.png'

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
        const state: AccountState =
          upstream.status === 429 ? 'rate_limit'
            : upstream.status === 401 || upstream.status === 403 ? 'session_dead'
              : upstream.status === 404 ? 'unavailable'
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
