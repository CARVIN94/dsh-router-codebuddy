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
import { ensureSystemHead, normalizeRoles, normalizeToolChoice } from './body.ts'

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
  // 企业号余额在另一张表（无 /v2 前缀，探 /v2 答 404）；个人表对企业成员会答
  // 200 + 空 Accounts，读它等于把「有额度」显示成 0。
  enterpriseUsageUrls: [
    `${BASE}/billing/meter/get-enterprise-user-usage`,
    `${BASE}/v2/billing/meter/get-enterprise-user-usage`,
  ],
  // 首选路径沿用实测可用的无 /v2 形态，/v2 变体只兜 404。
  checkinUrls: [`${BASE}/billing/meter/daily-checkin`, `${BASE}/v2/billing/meter/daily-checkin`],
  checkinStatusUrls: [
    `${BASE}/v2/billing/meter/checkin-activity-status`,
    `${BASE}/billing/meter/checkin-activity-status`,
  ],
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
  //
  // 2026-10-28 追加 11128：国内网关**同样**拿 11128 拒 DSH 自己的 system 开场白
  // （`You are an AI agent powered by DeepSeek Harness`：CN 400/11128，国际侧
  // 对同一句放行）。这是**请求形态**问题（同一 body 换号结果相同），故归
  // bad_request；出站侧已由 normalizeBody/normalizeBodyText + 内容指纹按句改写
  // 提前规避（后者是 2026-10-29 的主修复：CN 网关匹配前规范化零宽字符，只有真
  // 改词才 200），真出现说明撞上了没枚举过的句子，core.ts 会先走一次重试阶梯再报。
  classifyGatewayCode: (code) => {
    if (code === 11128) return 'bad_request'
    if (code === 11134) return 'rate_limit'
    if (code === 11133 || code === 11135) return 'bad_request'
    if (code === 11102) return 'no_such_model'
    if (code === 11103) return 'bad_request'
    return undefined
  },
  normalizeBody: (obj) => {
    // 防网关 11128/11101：developer 角色归一为 system；tool_choice 对象形态归一为 string。
    normalizeRoles(obj)
    normalizeToolChoice(obj)
  },
  // 首条不是 system 时补兜底 system（11128）。国内侧不剥 WAF 外壳：那条 WAF
  // 只在国际域名上实测到，无证据的字节改动不做。
  normalizeBodyText: (body) => {
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      ensureSystemHead(obj)
      return JSON.stringify(obj)
    } catch {
      return body
    }
  },
}
