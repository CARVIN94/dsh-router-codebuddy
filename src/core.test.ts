/**
 * codebuddy 族共享实现的回归闸门。
 *
 * 差异全部收敛进 cn.ts / en.ts 的 profile，共享逻辑只有 core.ts 一份 ——
 * 本测试锁住的就是**profile 边界**：
 *
 *   1. 国内侧不多发 system、不动 tool_choice、只打 /v2；
 *   2. 国际侧三个网关归一化存在（developer→system、tool_choice 对象→string、
 *      首条非 system 前置兜底）且**顺序正确**（补 system 必须在改 role 之后）；
 *   3. 端点候选回退只在 404/405 触发；
 *   4. 两个 id / 存储键 / uid 前缀不变 —— 改它 = 已登录账号全部消失。
 *
 * 运行：npm test（node --test，靠 Node 内建 TS 类型剥离）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupplier } from './core.ts'
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
function harness(id: string, opts: { creds?: boolean } = {}) {
  const calls: Call[] = []
  const creds = new Map<string, unknown>()
  if (opts.creds !== false) {
    creds.set('u1', { nickname: 'N', accessToken: 'tok', refreshToken: 'ref', expiresAt: FAR_FUTURE })
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

test('国内侧只打 /v2/chat/completions，不注入 system，不动 tool_choice', async () => {
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

  // 国内侧不做 11128 归一：请求体保持「原样 + model/stream/推理等级」
  assert.deepEqual(calls[0]!.body, {
    model: 'm',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
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

test('429/401 的分类不受 profile 影响', async () => {
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
