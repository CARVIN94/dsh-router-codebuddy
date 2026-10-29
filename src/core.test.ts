/**
 * codebuddy 族共享实现的回归闸门。
 *
 * 差异全部收敛进 cn.ts / en.ts 的 profile，共享逻辑只有 core.ts 一份 ——
 * 本测试锁住的就是**profile 边界**：
 *
 *   1. 国内侧只打 /v2，且与国内网关同源地做 11128 归一（developer→system、
 *      tool_choice 对象→string、首条非 system 前置兜底）；
 *   2. 国际侧多一层 WAF 外壳剥离，且**顺序正确**（补 system 必须在改 role 之后）；
 *   3. 端点候选回退只在 404/405 触发；
 *   4. 两个 id / 存储键 / uid 前缀不变 —— 改它 = 已登录账号全部消失；
 *   5. 国际侧出站净化剥 WAF 敏感词的命令替换外壳，词与其他反引号不动（issue #3）；
 *   6. 403 按 body 形态二分：JSON → session_dead，非 JSON（WAF HTML）→ bad_request；
 *   7. 11128 渠道闸：出站前先做内容指纹按句改写（实测被拒的那几句换措辞，
 *      没命中则逐字节不变），改写后仍被拒才走三级阶梯（原样 → 强制中性头 →
 *      零宽散点），耗尽报 bad_request（**不**判账号死）；
 *   8. 积分：读 cycle 家族、请求体带分页/产品码、企业号读企业表（剩余 = 上限 − 已用）；
 *   9. 签到：先读 active / today_checked_in，未开活动与已签到都**不发写请求**。
 *
 * 运行：npm test（node --test，靠 Node 内建 TS 类型剥离）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupplier } from './core.ts'
import { rewriteChannelFingerprintPhrases, rewriteChannelFingerprints } from './body.ts'
import { profile as cn } from './cn.ts'
import { profile as en } from './en.ts'
import type { SupplierEnv } from './contract.ts'

/** 记录每次出站的 fetch 调用。 */
interface Call {
  url: string
  init: RequestInit
  body: Record<string, unknown> | undefined
}

const FAR_FUTURE = Date.now() + 365 * 24 * 3600_000

/** 造一个假 env + 可编程的 fetch。 */
function harness(id: string, opts: { creds?: boolean; cred?: Record<string, unknown> } = {}) {
  const calls: Call[] = []
  const creds = new Map<string, unknown>()
  if (opts.creds !== false) {
    creds.set('u1', opts.cred ?? { nickname: 'N', accessToken: 'tok', refreshToken: 'ref', expiresAt: FAR_FUTURE })
  }
  const env: SupplierEnv = {
    dataDir: '/tmp',
    log: () => {},
    store: {
      get: () => ({
        alias: '',
        disabled: [],
        custom: [],
        poolOrder: [],
        poolStrategy: 'fallback' as const,
        credits: {},
      }),
      setAlias: () => {},
      setPoolOrder: () => {},
      setPoolStrategy: () => {},
      setModelEnabled: () => {},
      addCustomModel: () => {},
      removeCustomModel: () => {},
      setAllModelsEnabled: () => {},
      getCredits: () => -1,
      putCredits: (_i, _u, r) => r,
      clearCredits: () => {},
    },
    credentials: {
      list: () => [...creds.keys()],
      get: <T,>(_s: string, uid: string) => creds.get(uid) as T | undefined,
      save: (_s, uid, blob) => void creds.set(uid, blob),
      remove: (_s, uid) => void creds.delete(uid),
    },
  }
  void id

  /** 默认：200 流式成功。 */
  const respond = (url: string): Response =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ url })}\n\n`))
          c.close()
        },
      }),
      { status: 200 },
    )

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    let parsed: Record<string, unknown> | undefined
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        parsed = undefined
      }
    }
    calls.push({ url, init: init ?? {}, body: parsed })
    return respond(url)
  }) as typeof fetch

  return { env, calls }
}

/** 造一个「前 N 个候选返回 status，之后成功」的 fetch。 */
function scripted(calls: Call[], statuses: number[]): void {
  let i = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    let parsed: Record<string, unknown> | undefined
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        parsed = undefined
      }
    }
    calls.push({ url, init: init ?? {}, body: parsed })
    const status = statuses[i++] ?? 200
    if (status === 200) {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: ok\n\n'))
            c.close()
          },
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ code: 1234, msg: 'nope' }), { status })
  }) as typeof fetch
}

const req = { rawBody: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }), stream: false, model: 'm' }

// ---------------------------------------------------------------- 身份

test('两个供应商的 id / 名字 / 存储键逐字保留', () => {
  // id 同时是凭证与配置的存储键：改它 = 已登录账号全部消失
  assert.equal(cn.id, 'codebuddy')
  assert.equal(en.id, 'codebuddy-en')
  assert.equal(cn.name, 'CodeBuddy')
  assert.equal(en.name, 'CodeBuddyEN')
  assert.equal(cn.uidPrefix, 'cb')
  assert.equal(en.uidPrefix, 'wb')
  assert.equal(cn.domain, 'copilot.tencent.com')
  assert.equal(en.domain, 'www.workbuddy.ai')
  // 图标必须内联 data URI：面板图标不该依赖另一个服务活着
  for (const p of [cn, en]) assert.match(p.icon, /^data:image\//)
  // 两个供应商共用同一张封面图（CodeBuddy 官方 logo）—— 同族同封面
  assert.equal(cn.icon, en.icon)
})

test('模块暴露契约要求的能力', () => {
  for (const p of [cn, en]) {
    const m = createSupplier(p)(harness(p.id).env)
    assert.equal(m.id, p.id)
    assert.equal(m.name, p.name)
    assert.equal(m.priority, p.priority)
    for (const k of ['status', 'listModels', 'chatOnce', 'dispose', 'generateLoginUrl', 'completeLogin', 'removeLink', 'pollLogin', 'checkinNow'] as const) {
      assert.equal(typeof m[k], 'function', `${p.id}.${k}`)
    }
  }
})

// ---------------------------------------------------------------- 国内侧：行为逐字保留

/**
 * 国内侧的「过闸」归一是 2026-10-28 补上的，与原本的假设相反：
 *
 * 旧注释写「国内侧不做 11128 归一」，但参照实现（dsh-connect-workbuddy）在真实
 * CN 号上实测到同一个 DSH system 开场白会被国内网关以 400/11128 拒
 * （`Illegal API invocation from an unapproved channel`），而国际侧对同一句
 * 放行。两个网关同族，所以归一化规则对两侧都成立，只有 WAF 外壳剥离是国际侧
 * 独有的（那条 WAF 只在国际域名上实测到）。
 */
test('国内侧只打 /v2/chat/completions，并做与国内网关同源的 11128 归一', async () => {
  const { env, calls } = harness(cn.id)
  const m = createSupplier(cn)(env)
  const r = await m.chatOnce('u1', 'auto', req)
  assert.equal(r.ok, true)

  assert.equal(calls.length, 1, '国内侧是单端点，不该有第二个候选')
  assert.equal(calls[0]!.url, 'https://copilot.tencent.com/v2/chat/completions')

  const h = calls[0]!.init.headers as Record<string, string>
  assert.equal(h['User-Agent'], 'CLI/2.108.1 CodeBuddy/2.108.1')
  assert.equal(h['X-Product'], 'SaaS')
  assert.equal(h['X-IDE-Type'], 'CLI')
  assert.equal(h.Authorization, 'Bearer tok')
  // 国际版的指纹头不该出现在国内侧
  assert.equal(h.Origin, undefined)
  assert.equal(h['Accept-Language'], undefined)
  assert.equal(h['X-No-Enterprise-Id'], undefined)
  // 会话身份三连两侧都要带（缺了就是 11128「不是官方客户端」）
  for (const k of ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']) {
    assert.match(h[k] ?? '', /^[0-9a-f-]{36}$/i, k)
  }

  // 首条是 user → 必须补一条兜底 system（网关要求会话以 system 开场）
  assert.deepEqual(calls[0]!.body, {
    model: 'm',
    stream: true,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ],
  })
})

test('国内侧：developer 已改写成 system，不再重复补 head（顺序语义）', async () => {
  const { env, calls } = harness(cn.id)
  const m = createSupplier(cn)(env)
  await m.chatOnce('u1', 'auto', {
    ...req,
    rawBody: JSON.stringify({
      model: 'm',
      messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
      tool_choice: { type: 'auto' },
    }),
  })
  const sent = calls[0]!.body!
  assert.equal(sent.tool_choice, 'auto')
  assert.deepEqual(
    (sent.messages as Array<{ role: string }>).map((x) => x.role),
    ['system', 'user'],
    'developer → system 之后首条已是 system，不该再补一条',
  )
})

test('国内侧推理等级：非 auto 加 reasoning_effort+reasoning_summary，auto 删字段', async () => {
  const { env, calls } = harness(cn.id)
  const m = createSupplier(cn)(env)
  const withReasoning = JSON.stringify({ model: 'm', reasoning_effort: 'stale', reasoning_summary: 'stale' })

  await m.chatOnce('u1', 'high', { ...req, rawBody: withReasoning })
  assert.equal(calls[0]!.body!.reasoning_effort, 'high')
  assert.equal(calls[0]!.body!.reasoning_summary, 'auto')

  await m.chatOnce('u1', 'auto', { ...req, rawBody: withReasoning })
  assert.equal(calls[1]!.body!.reasoning_effort, undefined)
  assert.equal(calls[1]!.body!.reasoning_summary, undefined)
})

// ---------------------------------------------------------------- 国际侧：三个归一化

test('国际侧 chat 先 /console，404 回退 /v2', async () => {
  const { env, calls } = harness(en.id)
  scripted(calls, [404, 200])
  const m = createSupplier(en)(env)
  const r = await m.chatOnce('u1', 'auto', req)
  assert.equal(r.ok, true)
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://www.workbuddy.ai/console/chat/completions', 'https://www.workbuddy.ai/v2/chat/completions'],
  )
})

test('国际侧候选回退只在 404/405 触发：400 直接返回，不换路径', async () => {
  const { env, calls } = harness(en.id)
  scripted(calls, [400, 200])
  const m = createSupplier(en)(env)
  const r = await m.chatOnce('u1', 'auto', req)
  assert.equal(r.ok, false)
  assert.equal(calls.length, 1, '400 是语义错误，不该再试第二个端点')
})

test('国际侧请求头是指纹头', async () => {
  const { env, calls } = harness(en.id)
  const m = createSupplier(en)(env)
  await m.chatOnce('u1', 'auto', req)
  const h = calls[0]!.init.headers as Record<string, string>
  assert.equal(h['User-Agent'], 'WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1')
  assert.equal(h.Origin, 'https://www.workbuddy.ai')
  assert.equal(h.Referer, 'https://www.workbuddy.ai/')
  assert.equal(h['Accept-Language'], 'en-US')
  assert.equal(h['X-No-Enterprise-Id'], '1')
  assert.equal(h.Accept, 'application/json, text/event-stream')
})

test('国际侧归一：developer→system + tool_choice 对象→string + 首条补 system', async () => {
  const { env, calls } = harness(en.id)
  const m = createSupplier(en)(env)
  const body = JSON.stringify({
    model: 'm',
    messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
    tool_choice: { type: 'auto' },
    tools: [{ type: 'function', function: { name: 'f' } }],
  })
  await m.chatOnce('u1', 'auto', { ...req, rawBody: body })

  const sent = calls[0]!.body!
  assert.equal(sent.tool_choice, 'auto')
  // developer 已改写成 system，因此**不该**再补一条兜底 system（顺序语义）
  assert.deepEqual(
    (sent.messages as Array<{ role: string }>).map((x) => x.role),
    ['system', 'user'],
  )
})

test('国际侧归一：首条非 system 时前置兜底 system', async () => {
  const { env, calls } = harness(en.id)
  const m = createSupplier(en)(env)
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  await m.chatOnce('u1', 'auto', { ...req, rawBody: body })
  const msgs = calls[0]!.body!.messages as Array<{ role: string; content: string }>
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.role, 'system')
  assert.equal(msgs[1]!.role, 'user')
})

test('国际侧 tool_choice：function 对象取函数名；none 连 tools 一起删', async () => {
  const { env, calls } = harness(en.id)
  const m = createSupplier(en)(env)

  await m.chatOnce('u1', 'auto', {
    ...req,
    rawBody: JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 's' }], tool_choice: { type: 'function', function: { name: 'get_x' } } }),
  })
  assert.equal(calls[0]!.body!.tool_choice, 'get_x')

  await m.chatOnce('u1', 'auto', {
    ...req,
    rawBody: JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 's' }], tool_choice: { type: 'none' }, tools: [{ type: 'function' }] }),
  })
  assert.equal(calls[1]!.body!.tool_choice, undefined)
  assert.equal(calls[1]!.body!.tools, undefined, '上游没有 none，tools 必须一起删')
})

// ---------------------------------------------------------------- 网关 code 归类

test('网关 code 归类：请求形态错归 bad_request（不冷号），只有临时故障归 rate_limit', async () => {
  // 11133/11135/11128 都是「这条请求有问题」——同一个请求对池里每个号都会
  // 失败，冷号会把一次请求错误放大成「这个模型谁都别用」（2026-09-15 读图
  // 11148/11133 事故：money 组合两条腿同时被冷 = 之后连文本也全灭 503）。
  assert.equal(cn.classifyGatewayCode?.(11133), 'bad_request', '参数非法不是账号的错')
  assert.equal(cn.classifyGatewayCode?.(11135), 'bad_request', '图片无法识别不是账号的错')
  assert.equal(en.classifyGatewayCode?.(11133), 'bad_request')
  assert.equal(en.classifyGatewayCode?.(11128), 'bad_request', '首条非 system 是请求形态问题')
  // 11134 = 上游临时不可用，仍走瞬冷换号（有号可换时换号确实管用）
  assert.equal(cn.classifyGatewayCode?.(11134), 'rate_limit')
  assert.equal(en.classifyGatewayCode?.(11134), 'rate_limit')
  assert.equal(cn.classifyGatewayCode?.(99999), undefined, '没枚举的 code 交给 extError.type 兜底')
})

/**
 * 目录列着、实际调不动的两类「模型级」拒绝（2026-10-10 实测）。
 *
 * 两条都是在**全部 11 个 CN 账号**上逐号实测确认的：同一个模型对每个号结果
 * 完全相同（glm-4.7 → 11/11 号 400/11102；hunyuan-image-alpha →
 * 5/5 号 400/11103），而 glm-5.3/hy3 同批全 200。所以它们是**模型**的属性、
 * 不是账号的——这正是 `no_such_model` / `bad_request` 的判据：核心据此跳过
 * 本供应商而**不给账号记账**。若归 unknown，就会逐号冷却、把整个池遍历一遍
 * 才以 503 收场（现象：面板 30 个模型里 7 个点了就失败、且失败一次要等很久）。
 */
test('模型级拒绝：11102（已下架）归 no_such_model，11103（生图当聊天）归 bad_request', async () => {
  assert.equal(cn.classifyGatewayCode?.(11102), 'no_such_model', '目录未摘但上游已下架')
  assert.equal(en.classifyGatewayCode?.(11102), 'no_such_model')
  assert.equal(cn.classifyGatewayCode?.(11103), 'bad_request', '生图模型走不了 chat 端点')
  assert.equal(en.classifyGatewayCode?.(11103), 'bad_request')
  // 端到端：核心读到的 state 必须是这两个，而不是 unknown
  for (const [p, code, want] of [
    [cn, 11102, 'no_such_model'],
    [en, 11102, 'no_such_model'],
    [cn, 11103, 'bad_request'],
  ] as const) {
    const { env, calls } = harness(p.id)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        calls.push({ url, init: init ?? {}, body: undefined })
        return new Response(JSON.stringify({ code, msg: 'model level rejection' }), { status: 400 })
      }
      return new Response(JSON.stringify({ code: 1234, msg: 'nope' }), { status: 500 })
    }) as typeof fetch
    const r = await createSupplier(p)(env).chatOnce('u1', 'auto', req)
    assert.equal(r.ok === false ? r.state : '', want, `${p.id} code=${code}`)
  }
})

/**
 * **403 + 11140 属于账号级风控，不是请求级拒绝**（2026-10-10 实测订正）。
 *
 * 这条判据是踩出来的：11140 的响应体带 `displayMsg`，写着
 * "The content did not pass the safety review."，看起来像内容审核（请求级）。
 * 但实测不是——同一段无害内容、甚至**不带任何 user 消息（仅 system）**也一样
 * 被拒，而同一时刻同样请求换本机另外两个号都能正常出字：
 *
 *   wb-1 system-only → 403/11140    wb-2 → 200    wb-3 → 200
 *   wb-1 system+hi   → 403/11140    wb-2 → 200    wb-3 → 200
 *   wb-1 不存在的模型 → 403/11140    wb-2 → 400/11102（模型级，正常报）
 *
 * 它描述的是「这个账号被风控」，所以必须是 session_dead（连接级冷却 30 分钟、
 * 到期自愈、**逐号换**）。若误判成 bad_request，核心会**跳过整个供应商**，
 * 那两个可用号就永远轮不到——一个错误分类直接变成可用性损失。
 * 同理也**不能**按 HTTP 状态之外的顺序把它提前判成请求级。
 */
test('403 + 11140 是账号级风控：归 session_dead（可换号），绝不归 bad_request', async () => {
  assert.equal(en.classifyGatewayCode?.(11140), undefined, '11140 不参与 code 归类（它是账号级，不是请求级）')
  assert.equal(cn.classifyGatewayCode?.(11140), undefined)
  for (const p of [cn, en] as const) {
    const { env, calls } = harness(p.id)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        calls.push({ url, init: init ?? {}, body: undefined })
        return new Response(
          JSON.stringify({ code: 11140, msg: 'request illegal', displayMsg: { en: 'The content did not pass the safety review.' } }),
          { status: 403 },
        )
      }
      return new Response(JSON.stringify({ code: 1234, msg: 'nope' }), { status: 500 })
    }) as typeof fetch
    const r = await createSupplier(p)(env).chatOnce('u1', 'auto', req)
    assert.equal(r.ok === false ? r.state : '', 'session_dead', `${p.id}: 403/11140 必须可换号，否则丢掉健康号`)
  }
})

/**
 * **403 按 body 形态二分**（issue #3，2026-10-16）：
 *
 *   - JSON body（业务风控 11140 等）→ 账号级 → session_dead（可换号）；
 *   - 非 JSON body（WAF Block Page HTML）→ 请求级 → bad_request（不冷号）。
 *
 * www.workbuddy.ai 前置 WAF 的「命令注入」规则把请求体里命令替换外壳包住的
 * 敏感词当 shell 命令执行，命中即 403 + HTML。WAF 在鉴权前判定（假 token 与
 * 真 token 结果一致），同一 body 对每个号都一样失败 —— 归 session_dead 会把
 * 一次 WAF 误判放大成单号池 30 分钟全灭 503，这正是 issue #3 的放大器。
 */
test('403 按 body 形态二分：非 JSON（WAF HTML）→ bad_request 不冷号；JSON → session_dead', async () => {
  for (const p of [cn, en] as const) {
    for (const [body, contentType, want] of [
      ['<!DOCTYPE html><html><head><title>WAF Block Page</title></head><body>blocked</body></html>', 'text/html', 'bad_request'],
      [JSON.stringify({ code: 9999, msg: 'account risk' }), 'application/json', 'session_dead'],
    ] as const) {
      const { env, calls } = harness(p.id)
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          calls.push({ url, init: init ?? {}, body: undefined })
          return new Response(body, { status: 403, headers: { 'Content-Type': contentType } })
        }
        return new Response(JSON.stringify({ code: 1234, msg: 'nope' }), { status: 500 })
      }) as typeof fetch
      const r = await createSupplier(p)(env).chatOnce('u1', 'auto', req)
      assert.equal(r.ok === false ? r.state : '', want, `${p.id}: 403 + ${contentType}`)
    }
  }
})

/**
 * issue #3：WAF 命中的是「命令替换外壳 + 敏感词」。出站净化剥外壳留词，
 * 语义无损（同一份 204KB body 去外壳后放行，实测）；非敏感词的反引号
 * 不动 —— 用户 markdown / 代码示例不受损。
 */
test('国际侧出站净化：敏感词的命令替换外壳剥掉、词保留；其他反引号不动', async () => {
  const { env, calls } = harness(en.id)
  const m = createSupplier(en)(env)
  const raw = JSON.stringify({
    model: 'm',
    messages: [
      {
        role: 'system',
        content: 'two-step: `confirm`, `Confirm`, `confirm: true`, $(whoami), `whoami`; untouched: `run_code`, confirm',
      },
      { role: 'user', content: 'hi' },
    ],
  })
  await m.chatOnce('u1', 'auto', { rawBody: raw, stream: false, model: 'm' })
  const sent = String(calls[0]!.init.body)
  assert.ok(!sent.includes('`confirm'), 'confirm 左侧外壳剥掉')
  assert.ok(!sent.includes('confirm`'), 'confirm 右侧外壳剥掉')
  assert.ok(!sent.includes('`Confirm'), '大小写变体同样命中 WAF，同样处理')
  assert.ok(!sent.includes('`whoami'), 'whoami 左侧外壳剥掉')
  assert.ok(!sent.includes('whoami`'), 'whoami 右侧外壳剥掉')
  assert.ok(!sent.includes('$(whoami)'), '$() 外壳也剥掉（实测命中的另一形态）')
  assert.ok(sent.includes('confirm: true'), '词与中间内容保留（语义无损）')
  assert.ok(sent.includes('`run_code`'), '非敏感词的反引号不动')
})

test('429/401/403(JSON) 的分类不受 profile 影响', async () => {
  for (const [p, status, want] of [
    [cn, 429, 'rate_limit'],
    [en, 429, 'rate_limit'],
    [cn, 401, 'session_dead'],
    [en, 403, 'session_dead'],
  ] as const) {
    const { env, calls } = harness(p.id)
    scripted(calls, [status])
    const m = createSupplier(p)(env)
    const r = await m.chatOnce('u1', 'auto', req)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false ? r.state : '', want, `${p.id} @${status}`)
  }
})

/**
 * 上游的 extError.type 是它自己打的语义标签，比枚举 code 更耐新：
 * 将来上游加一个新的「请求形态」错误码（我们枚举不到），只要它还带
 * invalid_request_error，就该归 bad_request 而不是 unknown 冷掉好号。
 */
test('未枚举的 400：extError.type=invalid_request_error → bad_request（不冷号）', async () => {
  for (const p of [cn, en] as const) {
    const { env, calls } = harness(p.id)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        calls.push({ url, init: init ?? {}, body: undefined })
        return new Response(
          JSON.stringify({ code: 11999, msg: 'brand new request error', extError: { type: 'invalid_request_error' } }),
          { status: 400 },
        )
      }
      return new Response(JSON.stringify({ code: 1234, msg: 'nope' }), { status: 500 })
    }) as typeof fetch
    const m = createSupplier(p)(env)
    const r = await m.chatOnce('u1', 'auto', req)
    assert.equal(r.ok === false ? r.state : '', 'bad_request', `${p.id} 未枚举 code + invalid_request_error`)
  }
})

test('未枚举的 400 且没有 invalid_request_error 标签 → 仍是 unknown（保守，不放过真故障）', async () => {
  const { env, calls } = harness(cn.id)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/chat/completions')) {
      calls.push({ url, init: init ?? {}, body: undefined })
      return new Response(JSON.stringify({ code: 11999, msg: 'mystery' }), { status: 400 })
    }
    return new Response(JSON.stringify({ code: 1234, msg: 'nope' }), { status: 500 })
  }) as typeof fetch
  const m = createSupplier(cn)(env)
  const r = await m.chatOnce('u1', 'auto', req)
  assert.equal(r.ok === false ? r.state : '', 'unknown', '说不清的错仍按 unknown 处理，不误判成 bad_request')
})

// ---------------------------------------------------------------- billing 双路径

test('国际侧 billing 无 /v2 优先，404 回退 /v2；国内侧单路径', async () => {
  for (const [p, want] of [
    [en, ['https://www.workbuddy.ai/billing/meter/get-user-resource', 'https://www.workbuddy.ai/v2/billing/meter/get-user-resource']],
    [cn, ['https://copilot.tencent.com/v2/billing/meter/get-user-resource']],
  ] as const) {
    const { env, calls } = harness(p.id)
    scripted(calls, want.map(() => 404))
    const m = createSupplier(p)(env)
    // status() 内部 fire-and-forget 拉积分；直接 await 一次显式刷新路径
    m.status()
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(
      calls.map((c) => c.url),
      [...want],
      p.id,
    )
  }
})

// ---------------------------------------------------------------- 未知模型/账号

test('未知账号与未知模型报 no_such_model（不记在账号头上）', async () => {
  const { env, calls } = harness(cn.id)
  const m = createSupplier(cn)(env)
  const unknownAcct = await m.chatOnce('nope', 'auto', req)
  assert.equal(unknownAcct.ok === false && unknownAcct.state, 'no_such_model')
  assert.equal(calls.length, 0, '不该打上游')
})

// ---------------------------------------------------------------- token 主动刷新轮换

/** 造一个带指定 iat（Unix 秒）的假 JWT accessToken。 */
function makeToken(iatSec: number): string {
  const b64 = (s: string): string => Buffer.from(s).toString('base64').replace(/=+$/, '')
  // 只用 payload 里的 iat；签名部分留空即可（本插件只解 iat，不验签）
  return `${b64('{"alg":"RS256","typ":"JWT"}')}.${b64(JSON.stringify({ iat: iatSec }))}.sig`
}

test('签发超过 15 天的 token：chat 前先走 refresh 轮换', async () => {
  const iat = Math.floor((Date.now() - 16 * 24 * 3600_000) / 1000)
  const cred = { nickname: 'N', accessToken: makeToken(iat), refreshToken: 'ref', expiresAt: FAR_FUTURE }
  const { env, calls } = harness(cn.id, { cred })
  const m = createSupplier(cn)(env)
  await m.chatOnce('u1', 'auto', req)
  const ref = calls.filter((c) => c.url.includes('/token/refresh'))
  assert.equal(ref.length, 1, '签发久远应该在发 chat 前刷新一次')
})

test('签发 1 天且未临到期：不主动刷新（保持旧行为）', async () => {
  const iat = Math.floor((Date.now() - 24 * 3600_000) / 1000)
  const cred = { nickname: 'N', accessToken: makeToken(iat), refreshToken: 'ref', expiresAt: FAR_FUTURE }
  const { env, calls } = harness(cn.id, { cred })
  const m = createSupplier(cn)(env)
  await m.chatOnce('u1', 'auto', req)
  const ref = calls.filter((c) => c.url.includes('/token/refresh'))
  assert.equal(ref.length, 0, '签发 1 天不该刷新')
})

test('无 iat 的 token（解不出签发时间）：回落到按 expiresAt 判，不误刷', async () => {
  const cred = { nickname: 'N', accessToken: 'not-a-jwt', refreshToken: 'ref', expiresAt: FAR_FUTURE }
  const { env, calls } = harness(cn.id, { cred })
  const m = createSupplier(cn)(env)
  await m.chatOnce('u1', 'auto', req)
  const ref = calls.filter((c) => c.url.includes('/token/refresh'))
  assert.equal(ref.length, 0, '解不出 iat 且未临到期，不该刷新')
})

// ------------------------------------------------ 6004 频率限制的重置时刻

/**
 * 2026-10-15 事故：11 个 CN 号全部撞 6004「您的使用量已超出频率限制，将在
 * … 重置」。上游**自己报了重置时刻**，但核心只做 5min 上限的指数退避 →
 * 到点回来再撞，号轮流被打冷。这里锁住：rate_limit 且文案带重置时刻时，
 * 必须把 epoch ms 交给核心（冷却语义在核心的 account-pool 测试里）。
 */
test('6004 频率限制：解析文案里的重置时刻（UTC+8/跨日），交给核心冷却', async () => {
  for (const [msg, want] of [
    ['您的使用量已超出频率限制，将在 2026-10-15 20:26:05 UTC+8 重置，您也可以切换其他模型继续使用。', Date.UTC(2026, 9, 15, 12, 26, 5)],
    ['您的使用量已超出频率限制，将在 2026-10-16 13:11:45 UTC+8 重置。', Date.UTC(2026, 9, 16, 5, 11, 45)],
  ] as const) {
    const { env, calls } = harness(cn.id)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {}, body: undefined })
      return new Response(JSON.stringify({ code: 6004, msg }), { status: 429 })
    }) as typeof fetch
    const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', req)
    assert.equal(r.ok === false ? r.state : '', 'rate_limit')
    assert.equal(r.ok === false ? r.resetAt : 0, want, msg)
  }
})

test('6004 文案没有可解析的重置时刻：不带 resetAt（fail-open，核心照旧退避）', async () => {
  const { env, calls } = harness(cn.id)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: undefined })
    return new Response(JSON.stringify({ code: 6004, msg: '您的使用量已超出频率限制，请稍后再试。' }), { status: 429 })
  }) as typeof fetch
  const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', req)
  assert.equal(r.ok === false ? r.state : '', 'rate_limit')
  assert.equal(r.ok === false ? r.resetAt : 0, undefined, '解析不出不该编造时刻')
})

test('非限流错误即使文案带时刻也不给 resetAt（冷却语义不串味）', async () => {
  const { env, calls } = harness(cn.id)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: undefined })
    return new Response(JSON.stringify({ code: 11133, msg: 'bad request，将在 2026-10-15 20:26:05 UTC+8 重置' }), { status: 400 })
  }) as typeof fetch
  const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', req)
  assert.equal(r.ok === false ? r.state : '', 'bad_request')
  assert.equal(r.ok === false ? r.resetAt : 0, undefined)
})

// ------------------------------------------------------- 11128 渠道闸与重试阶梯

/** 按 URL 分派的 fetch：handler 拿到 (url, body, 同 URL 的第几次调用)。 */
function routed(
  calls: Call[],
  handler: (url: string, body: Record<string, unknown> | undefined, seen: number) => Response,
): void {
  const counts = new Map<string, number>()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    let parsed: Record<string, unknown> | undefined
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        parsed = undefined
      }
    }
    calls.push({ url, init: init ?? {}, body: parsed })
    const seen = counts.get(url) ?? 0
    counts.set(url, seen + 1)
    return handler(url, parsed, seen)
  }) as typeof fetch
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status })
}

function okStream(): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: ok\n\n'))
        c.close()
      },
    }),
    { status: 200 },
  )
}

/** 上游真实的 11128 响应形状。 */
const CHANNEL_GATE = {
  code: 11128,
  msg: 'Illegal API invocation from an unapproved channel',
  displayTips: { zh: '可能不是官方客户端发出的' },
}

/** 一份「会撞渠道闸」的请求体：system 以被禁开场白开头。 */
const GATED_BODY = JSON.stringify({
  model: 'm',
  messages: [{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness. Do the task.' }],
})

test('11128：先改请求（强制中性头）重试同一个号，重试成功就当成功', async () => {
  for (const p of [cn, en] as const) {
    const { env, calls } = harness(p.id)
    routed(calls, (_url, _body, seen) => (seen === 0 ? jsonResponse(CHANNEL_GATE, 400) : okStream()))
    const r = await createSupplier(p)(env).chatOnce('u1', 'auto', { ...req, rawBody: GATED_BODY })
    assert.equal(r.ok, true, `${p.id}: 中性头重试应当救回来`)
    assert.equal(calls.length, 2, `${p.id}: 第二次是同一端点（闸读请求不读账号）`)
    const messages = calls[1]!.body!.messages as Array<{ role: string; content: string }>
    // 开场白的内容指纹在**出站前**已被按句改写过（见 body.ts 的 CHANNEL_GATE_PHRASES），
    // 阶梯只负责把它挪到中性头之后 —— 两件事分开断言，别混成一条。
    assert.match(
      messages[0]!.content,
      /^You are a helpful assistant\.\n\nYou are an AI agent running inside DeepSeek Harness/,
      `${p.id}: 被禁开场白必须挪到中性头之后（且已是改写后的措辞）`,
    )
  }
})

test('11128：一次中性头还不够时用零宽散点再试一次（三级阶梯）', async () => {
  const { env, calls } = harness(cn.id)
  // 前两次都被拒（第一次原样、第二次中性头），第三次放行
  routed(calls, (_url, _body, seen) => (seen < 2 ? jsonResponse(CHANNEL_GATE, 400) : okStream()))
  const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', { ...req, rawBody: GATED_BODY })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 3)
  const third = String(calls[2]!.init.body)
  assert.ok(third.includes('\u200b'), '第三级必须带零宽空格（打断精确子串指纹）')
  assert.ok(third.includes('You are a helpful assistant.'), '零宽散点是叠加在中性头之上的')
})

test('11128：三级都被拒 → bad_request（不判账号死，让核心跳过本供应商）', async () => {
  const { env, calls } = harness(cn.id)
  routed(calls, () => jsonResponse(CHANNEL_GATE, 400))
  const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', { ...req, rawBody: GATED_BODY })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false ? r.state : '', 'bad_request')
  assert.equal(calls.length, 3, '最多三级，不多打上游')
  // 三次的 body 必须逐级不同，否则那两次请求纯属浪费
  assert.notEqual(String(calls[0]!.init.body), String(calls[1]!.init.body))
  assert.notEqual(String(calls[1]!.init.body), String(calls[2]!.init.body))
})

test('非渠道闸的错误不重试（重试只对 11128 有意义）', async () => {
  const { env, calls } = harness(cn.id)
  routed(calls, () => jsonResponse({ code: 11133, msg: 'bad params' }, 400))
  const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', { ...req, rawBody: GATED_BODY })
  assert.equal(r.ok === false ? r.state : '', 'bad_request')
  assert.equal(calls.length, 1, '11133 是参数问题，改内容不解决问题，不该重试')
})

// --------------------------------------- 内容指纹：出站前按句改写（2026-10-29 实测）

/**
 * 一份**真实形状**的 DSH system：三处实测指纹都在里面，`@` 路径段按宿主原文。
 *
 * 为什么要这一份：CN 网关按**内容**拒（11128），而零宽扰动被它规范化掉了 ——
 * 实测本机同一份 system 只把这几个词换掉就 2/2 全过。测试锁的就是「换掉」。
 */
const DSH_SYSTEM = [
  'You are an AI agent powered by DeepSeek Harness.',
  'You are a coding agent powered by the qmodel_38max model.',
  'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.',
  'Agent Teams is available in this session.',
  'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.',
].join('\n\n')

const DSH_BODY = JSON.stringify({
  model: 'm',
  messages: [
    { role: 'system', content: DSH_SYSTEM },
    { role: 'user', content: 'hi' },
  ],
})

test('内容指纹：出站前就把实测命中的句子改写掉（不是靠零宽扰动）', async () => {
  const { env, calls } = harness(cn.id)
  routed(calls, () => okStream())
  await createSupplier(cn)(env).chatOnce('u1', 'auto', { ...req, rawBody: DSH_BODY })
  const sent = String(calls[0]!.init.body)
  for (const from of [
    'You are an AI agent powered by DeepSeek Harness',
    'You are a coding agent powered by the ',
    'You are interacting with the user through the DeepSeek Harness Web GUI',
    'Agent Teams is available in this session',
    'Tokens prefixed with @ are paths the user explicitly referenced.',
    'Relative paths resolve from the workspace root;',
    '@"..." quotes a path containing spaces.',
  ]) {
    assert.ok(!sent.includes(from), `命中句必须已被改写：${from}`)
  }
  // 语义不变：改写后的句子仍是指令，不是被删掉
  assert.ok(sent.includes('You are an AI agent running inside DeepSeek Harness.'))
  assert.ok(sent.includes('Paths that begin with @ are the ones the user explicitly referenced.'))
})

test('内容指纹：截断形态（该段前 112 字）也会被清掉 —— 最小触发跨度只到第二句', () => {
  // #164 实测：`@` 路径段前两句（112 字）就会 11128，两句各自单发都 200。
  // 所以只覆盖整段的字面量不够，行必须细到句子。
  const truncated = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root'
  const out = rewriteChannelFingerprintPhrases(truncated)
  assert.ok(!out.includes('Tokens prefixed with @ are paths the user explicitly referenced.'))
  assert.ok(!out.includes('Relative paths resolve from the workspace root'))
  assert.ok(out.includes('Paths that begin with @ are the ones the user explicitly referenced.'))
})

test('内容指纹：普通对话逐字节不变，且改写幂等', () => {
  const ordinary = 'A perfectly ordinary sentence. And one more.'
  assert.equal(rewriteChannelFingerprintPhrases(ordinary), ordinary)
  const once = rewriteChannelFingerprintPhrases(DSH_SYSTEM)
  assert.equal(rewriteChannelFingerprintPhrases(once), once, '第二遍必须是空操作')
})

test('内容指纹：只碰 system/assistant，user 自己的话一个字都不改', () => {
  const body = JSON.stringify({
    model: 'm',
    messages: [
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'user', content: 'You are an AI agent powered by DeepSeek Harness.' },
    ],
  })
  const out = rewriteChannelFingerprints(body)
  const msgs = (JSON.parse(out) as { messages: Array<{ role: string; content: string }> }).messages
  assert.ok(!msgs[0]!.content.includes('powered by'), 'system 必须改写')
  assert.ok(msgs[1]!.content.includes('powered by'), 'user 原文必须保留（闸不扫它，改它等于篡改用户输入）')
})

test('内容指纹：没命中任何一行 → 返回入参原文（不重新序列化）', () => {
  // 上游本来就 200 的请求必须逐字节不变：这里故意给一份「格式不规范但没指纹」的 body
  const untouched = '{"model":"m",   "messages":[{"role":"user","content":"hi"}]}'
  assert.equal(rewriteChannelFingerprints(untouched), untouched)
})

test('会话身份三连每请求现生成，不是固定值', async () => {
  const { env, calls } = harness(cn.id)
  const m = createSupplier(cn)(env)
  await m.chatOnce('u1', 'auto', req)
  await m.chatOnce('u1', 'auto', req)
  const idOf = (i: number): string =>
    (calls[i]!.init.headers as Record<string, string>)['X-Conversation-ID'] ?? ''
  assert.match(idOf(0), /^[0-9a-f-]{36}$/i)
  assert.notEqual(idOf(0), idOf(1), '同一秒的两个请求不能共用会话 id')
})

// ---------------------------------------------------------------- 积分

test('积分请求体带分页/产品码/状态/时间窗（发 {} 会漏包）', async () => {
  const { env, calls } = harness(en.id)
  routed(calls, (url) =>
    url.includes('get-user-resource') ? jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [] } } } }) : jsonResponse({}, 500),
  )
  const m = createSupplier(en)(env)
  m.status()
  await new Promise((r) => setTimeout(r, 50))
  const sent = calls.find((c) => c.url.includes('get-user-resource'))!.body!
  assert.equal(sent.PageNumber, 1)
  assert.equal(sent.PageSize, 100)
  assert.equal(sent.ProductCode, 'p_tcaca')
  assert.deepEqual(sent.Status, [0, 3])
  assert.match(String(sent.PackageEndTimeRangeBegin), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '上游只收本地墙钟格式')
  assert.match(String(sent.PackageEndTimeRangeEnd), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

test('积分余额按 cycle 家族求和：月度资源读 CycleCapacityRemain，过期/耗尽的赠送包不计', async () => {
  const { env, calls } = harness(en.id)
  const past = '2020-01-01 00:00:00'
  const future = '2099-01-01 00:00:00'
  routed(calls, (url) =>
    url.includes('get-user-resource')
      ? jsonResponse({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [
                // 月度资源：两族数值故意不同，必须读 cycle 那族
                { CapacityType: 4, CycleCapacityRemain: 500, CycleCapacityRemainPrecise: '500', CapacityRemain: 500 },
                // 赠送包：Precise 带两位小数，必须保留
                { CapacityType: 1, CycleCapacityRemainPrecise: '1696.61', CapacityRemain: 2196, ExpiredTime: future },
                // 已过期 → 不计
                { CapacityType: 1, CapacityRemain: 300, ExpiredTime: past },
                // 已耗尽 → 不计
                { CapacityType: 1, CapacityRemain: 0 },
              ],
            },
          },
        },
      })
      : jsonResponse({}, 500),
  )
  const m = createSupplier(en)(env)
  m.status()
  await new Promise((r) => setTimeout(r, 50))
  const acct = m.status().accounts[0]!
  assert.equal(acct.credits, 2196.61, '500 + 1696.61；过期与耗尽的赠送包不能算进来')
})

test('企业号：读企业表，余额 = limitNum − credit（credit 是已消耗，不是余额）', async () => {
  const cred = { nickname: 'N', accessToken: 'tok', refreshToken: 'ref', expiresAt: FAR_FUTURE, enterpriseId: 'ent-1' }
  const { env, calls } = harness(en.id, { cred })
  routed(calls, (url) =>
    url.includes('get-enterprise-user-usage')
      ? jsonResponse({ code: 0, data: { credit: 1234, limitNum: 5000, cycleResetTime: '2026-11-01 00:00:00' } })
      : jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
  )
  const m = createSupplier(en)(env)
  m.status()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(m.status().accounts[0]!.credits, 3766)
  assert.ok(
    !calls.some((c) => c.url.includes('get-user-resource')),
    '有企业 ID 就不该去问个人表：它对企业成员答的是「空表」，不是余额',
  )
})

test('个人表答空 Accounts（企业成员的合法形状）：回退企业表取余额', async () => {
  const { env, calls } = harness(en.id)
  routed(calls, (url) => {
    if (url.includes('get-enterprise-user-usage')) {
      return jsonResponse({ code: 0, data: { Data: { credit: 250, limitNum: 1000 } } })
    }
    return jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
  })
  const m = createSupplier(en)(env)
  m.status()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(m.status().accounts[0]!.credits, 750)
})

test('两张表都读不出余额时报 -1（不是 0），核心据此保留上次的值', async () => {
  const { env } = harness(en.id)
  routed([], () => jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [] } } } }))
  const m = createSupplier(en)(env)
  m.status()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(m.status().accounts[0]!.credits, -1, '报 0 会把缓存冲成 0，面板永久显示 0 积分')
})

// ---------------------------------------------------------------- 签到

test('签到：先读状态，active=false（该区没办活动）→ 报未开放且不发写请求', async () => {
  const { env, calls } = harness(en.id)
  routed(calls, (url) =>
    url.includes('checkin-activity-status')
      ? jsonResponse({ code: 0, data: { active: false, today_checked_in: false, streak_days: 0 } })
      : jsonResponse({}, 200),
  )
  const r = await createSupplier(en)(env).checkinNow!('u1')
  assert.equal(r.ok, false)
  assert.match(String(r.message), /未开放/)
  assert.ok(!calls.some((c) => c.url.includes('daily-checkin')), '活动没开就别花一次写请求')
})

test('签到：today_checked_in=true → 报已签到、不发写请求、顺手刷新积分', async () => {
  const { env, calls } = harness(cn.id)
  routed(calls, (url) => {
    if (url.includes('checkin-activity-status')) {
      return jsonResponse({ code: 0, data: { active: true, today_checked_in: true, streak_days: 11 } })
    }
    if (url.includes('get-user-resource')) {
      return jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [{ CapacityType: 4, CycleCapacityRemain: 120 }] } } } })
    }
    return jsonResponse({}, 200)
  })
  const r = await createSupplier(cn)(env).checkinNow!('u1')
  assert.equal(r.ok, true)
  assert.equal(r.status, 'already')
  assert.match(String(r.message), /连续 11 天/)
  assert.ok(!calls.some((c) => c.url.includes('daily-checkin')))
  assert.ok(calls.some((c) => c.url.includes('get-user-resource')), '已签到也要刷新积分（用户点它就是想看额度）')
})

test('签到：active 且未签 → 真签发；状态读接口坏了则 fail-open 直接签', async () => {
  for (const statusFails of [false, true]) {
    const { env, calls } = harness(cn.id)
    routed(calls, (url) => {
      if (url.includes('checkin-activity-status')) {
        return statusFails
          ? new Response('not found', { status: 404 })
          : jsonResponse({ code: 0, data: { active: true, today_checked_in: false } })
      }
      if (url.includes('daily-checkin')) {
        return jsonResponse({ code: 0, data: { credit: 100, streak_days: 3 } })
      }
      return jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
    })
    const r = await createSupplier(cn)(env).checkinNow!('u1')
    assert.equal(r.ok, true, statusFails ? '状态读失败必须 fail-open' : '')
    assert.equal(r.status, 'ok')
    assert.match(String(r.message), /\+100 积分（连续 3 天）/)
  }
})

test('签到：上游仍回 10001（已签到）时依旧当成功 —— 预读与幂等码两条腿都在', async () => {
  const { env, calls } = harness(cn.id)
  routed(calls, (url) => {
    if (url.includes('checkin-activity-status')) return new Response('boom', { status: 500 })
    if (url.includes('daily-checkin')) return jsonResponse({ code: 10001, msg: '今天已经签过了' }, 400)
    return jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
  })
  const r = await createSupplier(cn)(env).checkinNow!('u1')
  assert.equal(r.ok, true)
  assert.equal(r.status, 'already')
})
