/**
 * 上游失败信封的业务码读取 —— 本事实全仓收敛在这一处。
 *
 * 移植自上游 dsh-connect-workbuddy 的 `businessCodeOf` /
 * `businessCodeOfDocument` / `asBusinessCode` / `statesBusinessCode`
 * （issue #127 review + issue #155 的两半修复，0abc9de，v5.12.3）。
 *
 * 为什么按**字段**读而不是在原文里搜子串：`'"code":11140'.includes` 只对一种
 * 序列化成立。实测网关是紧凑 JSON，但代理、重序列化器、嵌套信封能造出至少
 * 两种新拼法 —— `{"code": 11140}`（空格）与 `"code":"11140"`（字符串）——
 * 漏判的后果不是中性的：403 + JSON 会掉进 `session_dead`，报文变成
 * 「凭证失效」，把一个健康号往重新登录的死路上引。
 *
 * 读码顺序（与上游一致，顺序即安全性）：
 *
 * 1. `code` —— 信封自己声明的判定，最优先；
 * 2. `error.data.code` —— 积分类错误的文档化嵌套形状；
 * 3. `error.code` —— OpenAI 形状的信封，排在 `error.data.code` 之后；
 * 4. `data.code`；
 * 5. 全部落空且 JSON.parse 失败（截断体/HTML 页）→ 锚定 `"code"` 键 +
 *    数字边界的正则兜底 —— requestId 是十六进制，可能与业务码数字巧合，
 *    所以锚点必须是带引号的键而不是裸数字。
 *
 * 解析成功但一个 code 都没读到的重序列化拼写（大写键 `{"CODE":…}`）由调用方
 * 用原文小写 includes 兜底（见 core.ts 的 accountRestricted 判定）。
 *
 * 刻意**不读** `extError.code`：那是参数级明细，不是信封判定，提升它会让
 * 明细覆盖信封自己的答案。
 */

/** 一个 code 字段，数字与 4–6 位数字字符串两种拼法都收。 */
function asBusinessCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d{4,6}$/u.test(value.trim())) return Number(value.trim())
  return undefined
}

/** 已解析的失败文档里声明的业务码；没有则 undefined。 */
export function businessCodeOfDocument(raw: Record<string, unknown>): number | undefined {
  const direct = asBusinessCode(raw['code'])
  if (direct !== undefined) return direct
  // 文档化嵌套形状：{"error":{"data":{"code":…}}}。
  const error = raw['error']
  if (typeof error === 'object' && error !== null) {
    const data = (error as Record<string, unknown>)['data']
    if (typeof data === 'object' && data !== null) {
      const nested = asBusinessCode((data as Record<string, unknown>)['code'])
      if (nested !== undefined) return nested
    }
    // {"error":{"code":…}} —— 排在 error.data.code 之后，保持文档化嵌套优先。
    const direct = asBusinessCode((error as Record<string, unknown>)['code'])
    if (direct !== undefined) return direct
  }
  const data = raw['data']
  if (typeof data === 'object' && data !== null) {
    return asBusinessCode((data as Record<string, unknown>)['code'])
  }
  return undefined
}

/** 失败响应原文里的业务码；解析失败走正则兜底（截断体也可能带着 code）。 */
export function businessCodeOf(text: string): number | undefined {
  try {
    return businessCodeOfDocument(JSON.parse(text) as Record<string, unknown>)
  } catch {
    const match = /"code"\s*:\s*"?(\d{4,6}(?!\d))/u.exec(text)
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
}
