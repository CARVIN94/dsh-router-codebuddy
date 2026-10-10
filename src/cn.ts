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
  // 11134（上游临时不可用）是瞬时故障 → 短冷换号，别攒错误把整个池打垮。
  // 11133（请求参数非法）/11135（图片无法识别）**不是账号的错**：同一个请求
  // 对每个号都一样失败，冷号 = 把一次「请求有问题」放大成「这个模型谁都别用」
  // （2026-09-15 读图 11148/11133 事故）。归 bad_request，核心不惩罚账号。
  //
  // 2026-10-10 实测追加两条（`/v3/config` 列着但实际调不动的模型）：
  //  - 11102 `model [x] service info not found` —— 目录还没摘掉、上游已经下架。
  //    实测本账号 30 个已发布模型里 7 个如此（glm-4.7/glm-4.6/glm-4.6v/glm-5.0/
  //    minimax-m2.5/kimi-k2-thinking/hy4-preview-x）。归 no_such_model：核心
  //    跳过整个供应商、**不记在账号头上**；若归 unknown 就会逐号冷却、遍历
  //    全池后才以 503 收场 —— 与「模型不存在」的真实语义完全不符。
  //    注意**不能**改用目录里的元数据提前筛掉它们：实测这 7 个与可用的 23 个
  //    在 credits / supportsToolCall / vendor / supportsReasoning 上签名完全相同，
  //    也无法用 agents[].models 交集（会误杀 6 个实测可用的模型）。
  //  - 11103 `Backend [x] is not supported` —— 生图模型被当聊天模型调用。
  classifyGatewayCode: (code) => {
    if (code === 11134) return 'rate_limit'
    if (code === 11133 || code === 11135) return 'bad_request'
    if (code === 11102) return 'no_such_model'
    if (code === 11103) return 'bad_request'
    return undefined
  },
}
