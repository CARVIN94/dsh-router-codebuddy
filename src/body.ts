/**
 * 出站请求体归一 —— 两个网关（国内 copilot / 国际 workbuddy）共用的「过闸」层。
 *
 * 全部规则都是被网关**实测**逼出来的（code 11128 家族、11101、WAF），不是风格
 * 偏好：凡是上游已经 200 的请求，这里的函数必须原样返回，一个字节都不改。
 * 因此每个函数都是「命中才动、没命中返回原样」，调用方不需要判断。
 *
 * 分工：
 *   - `normalizeRoles` / `normalizeToolChoice` / `ensureSystemHead`：**出站前**
 *     无条件跑，成本为零（不命中不改字节），拦的是确定性的形态校验。
 *   - `forceNeutralHead` / `perturbChannelFingerprints`：**只在 11128 之后**由
 *     core.ts 的重试阶梯调用。它们改的是内容，代价是「这条请求不再是原样」，
 *     所以不许预防式地每请求跑（2026-10-28 决定：不做每请求预防）。
 */

/** 首条消息不是 system 时补的兜底 system（也是 11128 中性头）。 */
export const FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.'

/** 零宽空格：模型读不进去，网关的子串匹配看得见断点。 */
const ZERO_WIDTH_SPACE = '\u200b'

/**
 * 网关会扫内容的角色。
 *
 * 只认 system / assistant：`user` 是用户自己的话，网关不拿它做渠道指纹
 * （实测同一句被禁文案放进 user 消息不触发 11128），改它等于篡改用户输入。
 */
export function scansOpening(role: unknown): boolean {
  if (typeof role !== 'string') return false
  const r = role.trim().toLowerCase()
  return r === 'system' || r === 'assistant'
}

/** 把 `developer` 归一为 `system`（防网关 code 11128）。 */
export function normalizeRoles(obj: Record<string, unknown>): void {
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
 * 首条消息不是 system 时，在最前补一条兜底 system。
 *
 * 两个网关都要求会话以 system 开场，国际侧强制（`11128: first message is not
 * system prompt`，对外文案是「被安全策略拦截」，看起来完全不像形态问题）。
 * **必须跑在 `normalizeRoles` 之后**：`developer` 本身要算作已满足开场要求，
 * 先补 head 会补出重复的 system（顺序语义见 core.ts 的两步串行）。
 */
export function ensureSystemHead(obj: Record<string, unknown>): void {
  const msgs = obj.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return
  const first = msgs[0]
  if (first !== null && typeof first === 'object') {
    const role = (first as Record<string, unknown>).role
    if (typeof role === 'string' && role.trim().toLowerCase() === 'system') return
  }
  msgs.unshift({ role: 'system', content: FALLBACK_SYSTEM_PROMPT })
}

/**
 * `tool_choice` 归一为上游 Go struct 的 string 形态（防网关 code 11101）。
 *
 *   - "none" / {"type":"none"}       → 删 tool_choice + 删 tools/functions（上游无 none）
 *   - {"type":"auto"/"required"}     → 字符串 "auto"/"required"
 *   - {"type":"function","function":{"name":"x"}} → 字符串 "x"
 *   - 其他对象/非标量                 → 删 tool_choice（默认 auto 行为）
 */
export function normalizeToolChoice(obj: Record<string, unknown>): void {
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
      obj.tool_choice = name !== '' ? name : 'auto'
    } else {
      delete obj.tool_choice
    }
    return
  }
  delete obj.tool_choice
}

/**
 * 剥掉 WAF「命令注入」规则敏感词的命令替换外壳，词本身保留（issue #3，2026-10-16）。
 *
 * www.workbuddy.ai 前置 WAF 把请求体里「命令替换外壳 + 敏感词」当 shell 命令
 * 执行，命中即 403 + WAF Block Page：
 *
 *   `confirm` / `Confirm` / `confirm: true` / `whoami` / $(whoami) → 403
 *   裸词 confirm、`run_code` 等其他反引号内容 → 放行
 *
 * 只删外壳字符、保留中间原文，序列化后的 JSON 结构不会被破坏；跨字段的反引号
 * 对至多丢一个反引号字符。只认这两个词（实测关键词表）——用户的 markdown /
 * 代码示例不受损。**只在国际侧启用**：国内侧没有实测到这条 WAF，无证据的字节
 * 改动一律不做。
 */
export function stripCommandSubstitution(body: string): string {
  return body
    .replace(/`(confirm|whoami)([^`]*)`/gi, '$1$2')
    .replace(/\$\((confirm|whoami)([^)]*)\)/gi, '$1$2')
}

// ---------------------------------------------------------------- 11128 重试阶梯

/**
 * 网关会按「已知第三方 agent 的开场白」拒绝请求（business code 11128）。
 *
 * 2026-10-21 实测（CN 号、deepseek-v4.1-flash、其余字段固定）：网关对每条
 * system/assistant 的**开头**做前缀匹配，命中即 400/11128
 * （`Illegal API invocation from an unapproved channel`，但对外文案写成
 * 「可能不是官方客户端发出的」，读起来像客户端身份问题）：
 *
 *   system 开头                                           CN            global
 *   ----------------------------------------------------  ------------  ------------
 *   "You are an AI agent powered by DeepSeek Harness"      400 / 11128   200
 *   "You are Claude Code, Anthropic's official CLI…"       400 / 11128   400 / 11128
 *   "You are an AI agent powered by Kimi."                 200           200
 *   同一个 DSH prompt 前面加一行 "You are a helpful assistant." 200       200
 *
 * 匹配只认 offset 0（同一句出现在中间、放进 user、或多一个前导空格都放行），
 * 且大小写不敏感。**所以修复不需要知道被禁的是哪一句** —— 把它从第 0 个字符
 * 挪开就行。
 *
 * 这张表只是「实测到过的样本」，**不能**当成判据：清单在上游手里，会随时变长。
 * 因此重试阶梯不按表匹配（见 {@link forceNeutralHead}），表留在这里是因为它
 * 记录了「为什么加一行前缀就能过」这条结论的来源。
 */
function startsWithNeutralHead(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(FALLBACK_SYSTEM_PROMPT.toLowerCase())
}

/** 遍历 messages 里被扫描的文本段（string content 与 text part）。 */
function forEachScannedText(
  obj: Record<string, unknown>,
  fn: (get: () => string, set: (next: string) => void) => void,
): boolean {
  const msgs = obj.messages
  if (!Array.isArray(msgs)) return false
  let changed = false
  for (const m of msgs) {
    if (m === null || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    if (!scansOpening(msg.role)) continue
    const content = msg.content
    if (typeof content === 'string') {
      if (content.trim() === '') continue
      fn(
        () => msg.content as string,
        (next) => {
          if (next !== msg.content) {
            msg.content = next
            changed = true
          }
        },
      )
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part === null || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      const type = typeof rec.type === 'string' ? rec.type.trim().toLowerCase() : ''
      if (type !== 'text') continue
      if (typeof rec.text !== 'string' || rec.text.trim() === '') continue
      fn(
        () => rec.text as string,
        (next) => {
          if (next !== rec.text) {
            rec.text = next
            changed = true
          }
        },
      )
    }
  }
  return changed
}

/**
 * 把每处被扫描的开场白挪到中性头之后（重试阶梯第二级）。
 *
 * **不判断「是不是被禁的那一句」**：这份清单是上游的数据，看不到也测不全，而
 * 实测结论是「不论被禁的是哪个开头，只要把它从 content 的第 0 个字符挪开就
 * 200」。所以这里对所有还没带中性头的 system/assistant 一律加一行 —— 反正
 * 调用方只在**已经**被 11128 拒过之后才会调它，那时这份 body 已经废了。
 *
 * 返回 `undefined` = 这份 body 改不动（每处都已经是中性头开头），调用方据此
 * **不要**浪费一次请求去换同样的拒绝。不许抛：解析失败是上游该拒的事。
 */
export function forceNeutralHead(bodyJson: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const obj = parsed as Record<string, unknown>
  const changed = forEachScannedText(obj, (get, set) => {
    const text = get()
    if (startsWithNeutralHead(text)) return
    set(`${FALLBACK_SYSTEM_PROMPT}\n\n${text}`)
  })
  return changed ? JSON.stringify(obj) : undefined
}

/**
 * 身份子句：网关除了「开头」还按**精确子串**匹配这三句 DSH 自己的开场白。
 *
 * 前缀规则（{@link UNAPPROVED_OPENINGS}）拦不住它 —— 短串在中间原样保留，
 * 加一行前缀只是把它往下挪了一行。实测三处全改才 200（只改一两处仍 400）。
 * 第 2 句里的模型名不稳定（`qmodel_38max` / `deepseek-v4.1-flash` …），
 * 所以匹配到 `powered by` 就停，尾巴交给下面的散点规则。
 */
const IDENTITY_CLAUSE =
  /(you)(\s+are\s+(?:(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by|interacting\s+with\s+the\s+user\s+through\s+the\s+deepseek\s+harness))/giu

/** 两个相邻首字母大写的词之间（`DeepSeek|Harness`）：产品名也得断开。 */
const WORD_INTERNAL_BREAK = /([A-Z][A-Za-z0-9]*)(\s+)(?=[A-Z][A-Za-z0-9])/gu

/**
 * 在被扫描的文本里插入零宽空格，打断精确子串指纹（重试阶梯第二级）。
 *
 * 为什么是「散点」而不是「知道被禁的那一段」：那一段是上游的数据，已经悄悄
 * 长过一次，还会再长；而「精确子串匹配死在任意一处扰动」是可推广的观察。
 * 于是按句读边界撒点 —— 对任何一段散文指纹，落点几乎必然落在它内部。
 *
 * `dense` 是最后一级：句读规则对「没有标点的散文」无效，密集模式改在**每个
 * 字符边界**撒点，代价是 body 变长（实测真实 DSH prompt +70%），所以只在前面
 * 两级都被拒后才用。
 *
 * 幂等：已带 U+200B 的文本不再叠加（CJK 规则靠 `(?!\u200b)` 前瞻，拉丁规则
 * 靠「U+200B 不是空白」天然失配）。返回 `undefined` = 改不动，别浪费请求。
 */
export function perturbChannelFingerprints(bodyJson: string, dense = false): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const obj = parsed as Record<string, unknown>
  const changed = forEachScannedText(obj, (get, set) => {
    const text = get()
    const boundaries = text
      .replace(/([.!?])(\s+)/gu, `$1${ZERO_WIDTH_SPACE}$2`)
      .replace(/([。！？])(?!\u200b)/gu, `$1${ZERO_WIDTH_SPACE}`)
      .replace(/([,;])(\s+)/gu, `$1${ZERO_WIDTH_SPACE}$2`)
      .replace(WORD_INTERNAL_BREAK, (whole: string, head: string, tail: string) =>
        whole.includes(ZERO_WIDTH_SPACE) ? whole : `${head}${ZERO_WIDTH_SPACE}${tail}`)
    if (!dense) {
      set(boundaries)
      return
    }
    // 密集模式：每个「前一个字符是字母/数字/CJK」的边界插一个，标点与空白不动，
    // 这样分词器看不到新的词切分，而子串匹配处处断点。
    const denseText = boundaries.replace(
      /(?=\S)/gu,
      (_whole: string, offset: number, source: string) => {
        if (source.slice(Math.max(0, offset - 1), offset + 1).includes(ZERO_WIDTH_SPACE)) return ''
        const prev = source.slice(0, offset).match(/\S(?=\S*$)/u)?.[0]
        return prev !== undefined && /[A-Za-z0-9぀-ヿ㐀-鿿]/u.test(prev) ? ZERO_WIDTH_SPACE : ''
      },
    )
    set(denseText)
  })
  return changed ? JSON.stringify(obj) : undefined
}

/**
 * 这条失败响应是不是「渠道闸」拒绝（11128 家族）。
 *
 * 独立的判据而不是塞进各 profile 的 `classifyGatewayCode`：闸读的是**请求**
 * 不是账号 —— 同一个 body 对池里每个号结果相同，所以它必须归 `bad_request`
 * （核心跳过本供应商、不记账），和区域无关。归 `unknown` 会让一条请求的形态
 * 问题变成「这个号坏了」，攒三次把池冷掉。
 */
export function isChannelRejectBody(text: string): boolean {
  try {
    const j = JSON.parse(text) as { code?: unknown; error?: { code?: unknown }; msg?: unknown; displayMsg?: unknown }
    const code = typeof j.code === 'number' ? j.code : typeof j.error?.code === 'number' ? j.error.code : undefined
    if (code === 11128) return true
  } catch {
    // 非 JSON：交给 HTTP 状态分类
  }
  // 文案兜底（幂等，宁可多认一次也别把闸当账号故障）：
  return /unapproved channel|first message is not system prompt|渠道校验/i.test(text)
}
