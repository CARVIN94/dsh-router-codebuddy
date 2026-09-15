/**
 * codebuddy-en（WorkBuddy 国际版）供应商 profile —— 上游 https://www.workbuddy.ai。
 *
 * 腾讯国际版 AI 办公工作台 WorkBuddy，与国内 copilot.tencent.com **同族同契约**
 * （OAuth 轮询登录 + OpenAI 兼容流式 chat + billing/meter 积分签到），差异只有
 * base/路径候选/指纹头/兜底模型，全部落在下面这份 profile 里；共享逻辑在 core.ts。
 * 参考 Sliverkiss/workbuddy2api。
 *
 * ⚠️ `id = 'codebuddy-en'` **同时是凭证与配置的存储键**（auths/{id}、
 * supplier-config.json、积分缓存）。改它 = 换一个供应商，已登录账号会全部消失。
 */
import type { ModelInfo } from './types.ts'
import type { SupplierProfile } from './core.ts'
import { CODEBUDDY_ICON } from './icon.ts'

const BASE = 'https://www.workbuddy.ai'

/**
 * 面板图标 —— 与国内 CodeBuddy 同一张封面图（CodeBuddy 官方 logo，128×128 PNG，base64 内联）。
 * 国际版 WorkBuddy 与国内同族同契约，封面图保持一致。
 */
const ICON = CODEBUDDY_ICON

/**
 * 兜底模型列表：不是「当前可用模型」，只是上游 /v3/config 拿不到时的最后退路。
 * 注意保持精简——用户面板里的自定义模型和这份列表是并集。
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gpt-5.6-sol', context_length: 1000000 },
  { id: 'gpt-5.6-terra', context_length: 1000000 },
  { id: 'gpt-5.6-luna', context_length: 1000000 },
  { id: 'gpt-5.5', context_length: 1000000 },
  { id: 'gpt-5.4', context_length: 512000 },
  { id: 'gemini-3.5-flash', context_length: 1000000 },
  { id: 'kimi-k3', context_length: 1000000 },
  { id: 'kimi-k2.6', context_length: 256000 },
]

/**
 * 请求头（global 国际版指纹头，参考 workbuddy2api headers.go）。
 *
 * 出站 UA 对齐官方 WorkBuddy 桌面版：国际版平台段用 `WorkBuddy AI`（送
 * `WorkBuddy` 可能触发上游 403 code 11140 风控）。Origin/Referer 同域、
 * Accept-Language en-US、X-No-Enterprise-Id:1 个人账号无企业 ID 显式声明。
 */
function headers(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1',
    'Origin': BASE,
    'Referer': `${BASE}/`,
    'Accept-Language': 'en-US',
    'X-No-Enterprise-Id': '1', // 个人账号无企业 ID，显式声明（避免上游按缺省判定）
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    ...extra,
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/**
 * 把 messages 里的 `developer` 角色归一为 `system`（防网关 code 11128）。
 *
 * 上游对 role 字段做白名单校验，`developer` 不在白名单内，命中即 HTTP 400
 * code=11128（workbuddy2api payload.go normalizeRoles）。`developer` 是 OpenAI 新规范
 * 里 system 的别名（Codex / Cursor 等新客户端用它承载 system 级指令），改写为
 * system 不丢语义。只认 developer 一个值，其余角色原样保留。
 */
function normalizeRoles(obj: Record<string, unknown>): void {
  const msgs = obj.messages
  if (!Array.isArray(msgs)) return
  for (const m of msgs) {
    if (m === null || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    if (typeof msg.role === 'string' && msg.role.trim().toLowerCase() === 'developer') {
      msg.role = 'system'
    }
  }
}

/**
 * 归一 tool_choice 为上游 Go struct 的 string 形态（防网关 code 11101）。
 *
 * 上游 tool_choice 字段是 string 类型，对象形态（`{"type":"auto"}` / `{"type":"function",
 * "function":{...}}`）命中即 HTTP 400 code=11101「Unmarshal chat params failed」
 * （实测 + workbuddy2api payload.go normalizeToolChoice）。OpenAI 新客户端（Codex 等）
 * 惯用对象形态。语义照搬参考实现：
 *   - "none" / {"type":"none"}       → 删 tool_choice + 删 tools/functions（上游无 none）
 *   - {"type":"auto"/"required"}     → 字符串 "auto"/"required"
 *   - {"type":"function","function":{"name":"x"}} → 字符串 "x"
 *   - 其他对象/非标量                 → 删 tool_choice（默认 auto 行为）
 */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj.tools
    delete obj.functions
  }
  const tc = obj.tool_choice
  if (tc === undefined) return
  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') {
      delete obj.tool_choice
      suppress()
    }
    return
  }
  if (tc !== null && typeof tc === 'object') {
    const v = tc as Record<string, unknown>
    const typ = typeof v.type === 'string' ? v.type.trim().toLowerCase() : ''
    if (typ === 'none') {
      delete obj.tool_choice
      suppress()
    } else if (typ === 'auto' || typ === 'required') {
      obj.tool_choice = typ
    } else if (typ === 'function') {
      const fn = v.function
      let name = ''
      if (fn !== null && typeof fn === 'object') name = String((fn as Record<string, unknown>).name ?? '')
      if (name === '') name = String(v.name ?? '')
      name = name.trim()
      if (name !== '') obj.tool_choice = name
      else obj.tool_choice = 'auto'
    } else {
      delete obj.tool_choice
    }
    return
  }
  delete obj.tool_choice
}

/**
 * 防网关 code 11128「first message is not system prompt」：首条消息不是 system 时，
 * 在 messages 最前补一条兜底 system。仅当首条确为 system 时不注入。
 * 参考 workbuddy2api ensureConsoleSystem（国际版 console 域上游要求首条为 system）。
 * body 不可解析时原样返回。
 */
function ensureConsoleSystem(body: string): string {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>
    const msgs = obj.messages
    if (!Array.isArray(msgs) || msgs.length === 0) return body
    const first = msgs[0]
    if (first !== null && typeof first === 'object') {
      const role = (first as Record<string, unknown>).role
      if (typeof role === 'string' && role.trim().toLowerCase() === 'system') return body
    }
    obj.messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      ...msgs,
    ]
    return JSON.stringify(obj)
  } catch {
    return body
  }
}

export const profile: SupplierProfile = {
  id: 'codebuddy-en',
  name: 'CodeBuddyEN',
  icon: ICON,
  priority: -1, // 与国内 codebuddy 同级，都排在 traework(0) 之前
  // 上游新旧路径分叉（workbuddy2api R9）：国际版首选 /console，404/405 回退 /v2。
  chatUrls: [`${BASE}/console/chat/completions`, `${BASE}/v2/chat/completions`],
  configUrl: `${BASE}/v3/config`,
  stateUrl: `${BASE}/v2/plugin/auth/state`,
  tokenUrl: `${BASE}/v2/plugin/auth/token`,
  refreshUrl: `${BASE}/v2/plugin/auth/token/refresh`,
  // global 国际版 billing 路径无 /v2 前缀（workbuddy2api R9），404 回退 /v2 变体。
  usageUrls: [`${BASE}/billing/meter/get-user-resource`, `${BASE}/v2/billing/meter/get-user-resource`],
  checkinUrls: [`${BASE}/billing/meter/daily-checkin`, `${BASE}/v2/billing/meter/daily-checkin`],
  domain: 'www.workbuddy.ai',
  headers,
  errPrefix: 'workbuddy',
  uidPrefix: 'wb',
  defaultNickname: 'WorkBuddy',
  fallbackModels: FALLBACK_MODELS,
  chatExtraHeaders: { Accept: 'application/json, text/event-stream' },
  // 11134（上游临时不可用）是瞬时故障 → 短冷换号。
  // 11128（首条不是 system）/11133（参数非法）/11135（图片认不出）都是**请求
  // 形态**问题，与账号无关——同一个请求对每个号结果相同，冷号无济于事。
  // 11128 我们已经通过 normalizeRoles + ensureConsoleSystem 在出站前规避；
  // 若仍出现，说明是这条请求的形态问题，报 bad_request 让核心换下一个，
  // 而不是把好号冷 30 秒（2026-09-15 读图事故的同型放大）。
  classifyGatewayCode: (code) => {
    if (code === 11134) return 'rate_limit'
    if (code === 11128 || code === 11133 || code === 11135) return 'bad_request'
    return undefined
  },
  normalizeBody: (obj) => {
    // 防网关 11128/11101：developer 角色归一为 system；tool_choice 对象形态归一为 string。
    normalizeRoles(obj)
    normalizeToolChoice(obj)
  },
  normalizeBodyText: ensureConsoleSystem,
}
