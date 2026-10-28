/**
 * codebuddy-en（WorkBuddy 国际版）供应商 profile —— 上游 https://www.workbuddy.ai。
 *
 * 腾讯国际版 AI 办公工作台 WorkBuddy，与国内 copilot.tencent.com **同族同契约**
 * （OAuth 轮询登录 + OpenAI 兼容流式 chat + billing/meter 积分签到），差异只有
 * base/路径候选/指纹头/兜底模型，全部落在下面这份 profile 里；共享逻辑在 core.ts，
 * 出站归一的通用规则在 body.ts。
 * 参考 Sliverkiss/workbuddy2api。
 *
 * ⚠️ `id = 'codebuddy-en'` **同时是凭证与配置的存储键**（auths/{id}、
 * supplier-config.json、积分缓存）。改它 = 换一个供应商，已登录账号会全部消失。
 */
import type { ModelInfo } from './types.ts'
import type { SupplierProfile } from './core.ts'
import { CODEBUDDY_ICON } from './icon.ts'
import { ensureSystemHead, normalizeRoles, normalizeToolChoice, stripCommandSubstitution } from './body.ts'

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
  // 企业号余额在另一张表（同样是先无 /v2）；个人表对企业成员答空 Accounts 而非报错。
  enterpriseUsageUrls: [
    `${BASE}/billing/meter/get-enterprise-user-usage`,
    `${BASE}/v2/billing/meter/get-enterprise-user-usage`,
  ],
  checkinUrls: [`${BASE}/billing/meter/daily-checkin`, `${BASE}/v2/billing/meter/daily-checkin`],
  // 签到状态读端点（ref 实测国际侧是 /v2 前缀一族）：404 才回退无前缀变体。
  checkinStatusUrls: [
    `${BASE}/v2/billing/meter/checkin-activity-status`,
    `${BASE}/billing/meter/checkin-activity-status`,
  ],
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
  // 11128 我们已经通过 normalizeRoles + ensureSystemHead 在出站前规避；
  // 若仍出现，core.ts 会先走一次 11128 重试阶梯（强制中性头 → 零宽散点），
  // 阶梯也失败才报 bad_request 让核心换下一个，而不是把好号冷 30 秒
  // （2026-09-15 读图事故的同型放大）。
  //
  // 11102/11103 与国内侧同义（模型已下架 / 生图模型当聊天用）。
  //
  // **11140 `request illegal` 刻意不在这里归类**（2026-10-10 实测订正）：
  // 它虽然带着 "The content did not pass the safety review" 的 displayMsg，
  // 但实测是**账号级**而非内容级——同一段无害内容、不带任何 user 消息（仅 system）
  // 也一样被拒；而同一时刻同请求换本机另外两个号（wb-2/wb-3）都能正常出字。
  // 也就是说它描述的是「这个账号被风控了」，不是「这条请求有问题」。
  // 归 bad_request 会让核心**跳过整个供应商、失去换号**，正好丢掉那两个可用号；
  // 留在默认的 403 → session_dead（连接级冷却 30 分钟、到期自愈、逐号换）才对。
  // 该判据只适用于 403 + **JSON body**（业务风控带 code）；403 + 非 JSON（WAF
  // Block Page HTML）是请求级拦截，core.ts 归 bad_request（issue #3）。
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
  // 串行两步：先补兜底 system（11128），再剥 WAF 敏感词的命令替换外壳（issue #3）
  normalizeBodyText: (body) => {
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      ensureSystemHead(obj)
      return stripCommandSubstitution(JSON.stringify(obj))
    } catch {
      return stripCommandSubstitution(body)
    }
  },
}
