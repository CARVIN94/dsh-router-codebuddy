/**
 * codebuddy（国内 CodeBuddy）供应商 profile —— 上游 https://copilot.tencent.com。
 *
 * 参考 9Router(openSSE) 的 codebuddy-cn 实现。全部共享逻辑在 core.ts，
 * 这里只声明这个网关的差异（base/路径/指纹头/兜底模型）。
 *
 * ⚠️ `id = 'codebuddy'` **同时是凭证与配置的存储键**（auths/{id}、
 * supplier-config.json、积分缓存）。改它 = 换一个供应商，已登录账号会全部消失。
 */
import type { ModelInfo } from './types.ts'
import type { SupplierProfile } from './core.ts'
import { CODEBUDDY_ICON } from './icon.ts'

const BASE = 'https://copilot.tencent.com'

/** 面板图标（CodeBuddy 官方 logo，128×128 PNG，base64 内联）。 */

/**
 * 兜底模型列表：不是「当前可用模型」，只是上游 /v3/config 拿不到时的最后退路。
 * 注意保持精简——用户面板里的自定义模型和这份列表是并集。
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'deepseek-v4-pro', context_length: 1000000 },
  { id: 'deepseek-v4-flash', context_length: 1000000 },
  { id: 'glm-5.3', context_length: 1000000 },
  { id: 'glm-5.3-flash', context_length: 1000000 },
  { id: 'glm-5.2', context_length: 1000000 },
  { id: 'minimax-m3', context_length: 512000 },
  { id: 'kimi-k3-1', context_length: 1000000 },
  { id: 'kimi-k2.7', context_length: 256000 },
  { id: 'hy4-preview', context_length: 1000000 },
  { id: 'hy3', context_length: 192000 },
  { id: 'hunyuan-chat', context_length: 200000 },
]

/** 请求头（同 9router codebuddy-cn transport.headers + auth bearer）。 */
function headers(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'CLI/2.108.1 CodeBuddy/2.108.1',
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

export const profile: SupplierProfile = {
  id: 'codebuddy',
  name: 'CodeBuddy',
  icon: CODEBUDDY_ICON,
  priority: -1, // 排在 traework(0) 之前
  chatUrls: [`${BASE}/v2/chat/completions`],
  configUrl: `${BASE}/v3/config`,
  stateUrl: `${BASE}/v2/plugin/auth/state`,
  tokenUrl: `${BASE}/v2/plugin/auth/token`,
  refreshUrl: `${BASE}/v2/plugin/auth/token/refresh`,
  usageUrls: [`${BASE}/v2/billing/meter/get-user-resource`],
  checkinUrls: [`${BASE}/billing/meter/daily-checkin`],
  domain: 'copilot.tencent.com',
  headers,
  errPrefix: 'codebuddy',
  uidPrefix: 'cb',
  defaultNickname: 'CodeBuddy',
  fallbackModels: FALLBACK_MODELS,
  // 11133（请求参数非法）/11134（上游临时不可用）都是瞬时/请求类，
  // 归 rate_limit = 单号短冷却换号，别攒错误把整个池打垮。
  classifyGatewayCode: (code) => (code === 11133 || code === 11134 ? 'rate_limit' : undefined),
}
