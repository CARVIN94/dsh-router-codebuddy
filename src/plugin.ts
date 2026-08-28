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
import type { ServerResponse } from 'node:http'
import type { ChatRequest, ModelInfo, SupplierStatus } from './types.ts'
import type { SupplierEnv, SupplierModule } from './contract.ts'

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
const REFRESH_SKEW_MS = 24 * 3600_000 // 到期前 24 小时内刷新（同 traework）
const COOL_DOWN_MS = 60 * 1000 // 失败冷却 60s

/** 模型来源：CodeBuddy 上游无公开 models 接口（copilot.tencent.com 不暴露），
 * 内置模型列表来自 WorkBuddy.app（CodeBuddy 官方桌面客户端）的 product.json，
 * 与 9router codebuddy-cn 一致。用户在面板仍可添加自定义模型。 */
const BUILTIN_MODELS: ModelInfo[] = [
  { id: 'deepseek-v4-pro', context_length: 1000000 },
  { id: 'deepseek-v4-flash', context_length: 1000000 },
  { id: 'deepseek-v3-2-volc', context_length: 96000 },
  { id: 'minimax-m2.5', context_length: 200000 },
  { id: 'minimax-m2.7', context_length: 200000 },
  { id: 'minimax-m3-play', context_length: 512000 },
  { id: 'glm-5.2', context_length: 200000 },
  { id: 'glm-5.1', context_length: 200000 },
  { id: 'glm-5.0', context_length: 200000 },
  { id: 'glm-5.0-turbo', context_length: 200000 },
  { id: 'glm-5v-turbo', context_length: 200000 },
  { id: 'glm-4.7', context_length: 200000 },
  { id: 'glm-4.6', context_length: 168000 },
  { id: 'glm-4.6v', context_length: 128000 },
  { id: 'kimi-k2.7-code', context_length: 256000 },
  { id: 'kimi-k2.7-code-highspeed', context_length: 256000 },
  { id: 'kimi-k2.6', context_length: 256000 },
  { id: 'kimi-k2.5', context_length: 256000 },
  { id: 'kimi-k2-thinking', context_length: 256000 },
  { id: 'hy3-preview-agent', context_length: 192000 },
  { id: 'hy3-preview', context_length: 192000 },
  { id: 'hunyuan-chat', context_length: 128000 },
  { id: 'hunyuan-2.0-thinking', context_length: 128000 },
  { id: 'hunyuan-2.0-instruct', context_length: 128000 },
  { id: 'deepseek-v3-1', context_length: 96000 },
  { id: 'deepseek-v3-1-volc', context_length: 96000 },
  { id: 'deepseek-r1-0528', context_length: 96000 },
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
function stripAlias(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

export default function factory(env: SupplierEnv): SupplierModule {
  const creds = env.credentials
  const store = env.store
  const log = env.log

  /** 进行中的登录 state。 */
  let pendingState: string | undefined
  let pendingUid: string | undefined

  const cooling = new Map<string, number>()

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

  function isCooling(uid: string, now = Date.now()): boolean {
    return (cooling.get(uid) ?? 0) > now
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
    status: (): SupplierStatus => {
      const now = Date.now()
      const accounts = orderedUids().map((uid) => {
        const cred = getCred(uid)
        return {
          uid,
          nickname: cred?.nickname || 'CodeBuddy',
          credits: 0,
          cooling: isCooling(uid, now),
          disabled: false,
          err_count: 0,
        }
      })
      return { id, name, accounts }
    },
    listModels: (): ModelInfo[] => BUILTIN_MODELS, // 内置模型列表(来自 WorkBuddy.app product.json),用户仍可自定义
    getAlias: (): string => 'cbcn',
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
      cooling.delete(uid)
      return Promise.resolve(true)
    },
    testModel: async (mid: string): Promise<{ ok: boolean; error?: string }> => {
      const base = stripAlias(mid)
      if (base === '') return { ok: false, error: `unknown model ${JSON.stringify(mid)}` }
      const uids = orderedUids()
      if (uids.length === 0) return { ok: false, error: '未添加链接（点「添加链接」登录 CodeBuddy）' }
      for (const uid of uids) {
        const cred = getCred(uid)
        if (!cred) continue
        const fresh = await refreshIfNeeded(uid, cred)
        try {
          const resp = await fetch(CHAT_URL, {
            method: 'POST',
            headers: headers(fresh.accessToken, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ model: base, messages: [{ role: 'user', content: 'ping' }], stream: true, max_tokens: 8 }),
            signal: AbortSignal.timeout(30000),
          })
          if (resp.ok) return { ok: true }
          const body = await resp.text().catch(() => '')
          return { ok: false, error: gatewayError(body, resp.status) }
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      }
      return { ok: false, error: 'no healthy account' }
    },
    async chatCompletions(req: ChatRequest, res: ServerResponse): Promise<boolean> {
      const base = stripAlias(req.model)
      if (base === '') return false
      const uids = orderedUids().filter((u) => !isCooling(u) && getCred(u) !== undefined)
      if (uids.length === 0) return false

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

      let lastErr = ''
      for (const uid of uids) {
        const cred = getCred(uid)
        if (!cred) continue
        let fresh = cred
        try {
          fresh = await refreshIfNeeded(uid, cred)
        } catch {
          // 刷新失败继续用旧 token
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
          cooling.set(uid, Date.now() + COOL_DOWN_MS)
          lastErr = (err as Error).message
          continue
        }
        if (upstream.status < 200 || upstream.status >= 300) {
          cooling.set(uid, Date.now() + COOL_DOWN_MS)
          const text = await upstream.text().catch(() => '')
          lastErr = gatewayError(text, upstream.status)
          continue
        }
        // 成功：透传 SSE（上游恒为流式）
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        if (!upstream.body) {
          res.end()
          return true
        }
        const reader = upstream.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(Buffer.from(value))
            if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
              ;(res as { flushHeaders: () => void }).flushHeaders()
            }
          }
        } finally {
          reader.releaseLock()
        }
        res.end()
        return true
      }
      log(`codebuddy chat failed: ${lastErr}`)
      return false
    },
    dispose: (): void => {
      cooling.clear()
    },
  }
}
