import { describe, expect, test } from 'bun:test'
import {
  createWorkBuddyProxyHandler,
  type WorkBuddyAccountFailure,
  type WorkBuddyProxyAccounts,
  type WorkBuddyProxyOptions,
} from '../proxy'
import type { WorkBuddySession } from '../types'

const SECRET = 'workbuddy-test-secret'
const BASE = `http://127.0.0.1/p/${SECRET}/v1`
const NOW = Date.UTC(2026, 10, 2, 11, 0, 0)
const MODELS = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek',
    contextWindow: 1_000_000,
    reasoning: true,
    vision: true,
    api: 'chat' as const,
  },
]

function sessionOf(handler: (request: Request) => Promise<Response>): WorkBuddySession {
  return {
    fetch: handler,
    usage: async () => ({ plan: null, windows: [], signIn: null, error: null }),
    checkin: async () => ({ outcome: 'ineligible', credit: null, streak: null, message: null }),
    validate: async () => undefined,
  }
}

interface Harness {
  readonly handler: (request: Request) => Promise<Response>
  readonly failures: { accountId: string; failure: WorkBuddyAccountFailure }[]
  readonly answered: string[]
  readonly asked: string[]
  readonly seen: Request[]
}

function harnessOf(
  answer: (accountId: string) => Response | Promise<Response>,
  accountIds: readonly string[] = ['a'],
  extra: { restingUntil?: number } = {},
): Harness {
  const failures: { accountId: string; failure: WorkBuddyAccountFailure }[] = []
  const answered: string[] = []
  const asked: string[] = []
  const seen: Request[] = []
  const options: WorkBuddyProxyOptions = {
    secret: SECRET,
    accounts: async () => {
      const handed: WorkBuddyProxyAccounts = {
        accounts: accountIds.map((id) => ({
          id,
          session: sessionOf(async (request) => {
            asked.push(id)
            seen.push(request)
            return await answer(id)
          }),
        })),
        ...(extra.restingUntil === undefined ? {} : { restingUntil: extra.restingUntil }),
      }
      return handed
    },
    models: () => MODELS,
    onAccountFailure: (accountId, failure) => failures.push({ accountId, failure }),
    onAccountAnswered: (accountId) => answered.push(accountId),
    upstream: 'https://upstream.test/v2/chat/completions',
  }
  return { handler: createWorkBuddyProxyHandler(options, () => NOW), failures, answered, asked, seen }
}

function chatRequest(init: { headers?: Record<string, string> } = {}): Request {
  return new Request(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true }),
  })
}

describe('WorkBuddy 本地反代', () => {
  test('只接受带口令的 chat 路径，并原样转发请求体', async () => {
    const seen: string[] = []
    const handler = createWorkBuddyProxyHandler({
      secret: SECRET,
      accounts: async () => ({
        accounts: [
          {
            id: 'a',
            session: sessionOf(async (request) => {
              seen.push(await request.text())
              return new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
            }),
          },
        ],
      }),
      models: () => MODELS,
      upstream: 'https://upstream.test/v2/chat/completions',
    })

    const response = await handler(chatRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: ok\n\n')
    expect(JSON.parse(seen[0] ?? '{}')).toEqual({ model: 'deepseek-v4.1-flash', stream: true })

    const wrong = new Request(`${BASE.replace(SECRET, 'wrong')}/chat/completions`, {
      method: 'POST',
      body: '{}',
    })
    expect((await handler(wrong)).status).toBe(404)
  })

  test('首选账号 401 时换下一个账号，并把失败交给宿主', async () => {
    const h = harnessOf(
      (id) => new Response(id === 'first' ? 'denied' : 'ok', { status: id === 'first' ? 401 : 200 }),
      ['first', 'second'],
    )
    const response = await h.handler(chatRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(h.asked).toEqual(['first', 'second'])
    expect(h.answered).toEqual(['second'])
    expect(h.failures).toMatchObject([{ accountId: 'first', failure: { kind: 'sign_in', status: 401, signIn: null } }])
  })

  test('没有账号时返回 401；都在休息时返回 429 + Retry-After', async () => {
    const empty = harnessOf(() => new Response('ok'), [])
    const signedOut = await empty.handler(chatRequest())
    expect(signedOut.status).toBe(401)
    expect(await signedOut.json()).toMatchObject({ error: { code: 'not_signed_in' } })

    const resting = harnessOf(() => new Response('ok'), [], { restingUntil: NOW + 90_000 })
    const cool = await resting.handler(chatRequest())
    expect(cool.status).toBe(429)
    expect(cool.headers.get('retry-after')).toBe('90')
    expect(await cool.json()).toMatchObject({ error: { code: 'all_accounts_resting' } })

    const models = await empty.handler(new Request(`${BASE}/models`))
    expect(models.status).toBe(200)
    expect(await models.json()).toMatchObject({ data: [{ id: 'deepseek-v4.1-flash' }] })
  })

  test('403 受限与 429 额度用尽都换号，并报出失败种类', async () => {
    const restricted = harnessOf(
      (id) =>
        new Response(id === 'one' ? '{"code":11140,"msg":"account has been restricted"}' : 'ok', {
          status: id === 'one' ? 403 : 200,
        }),
      ['one', 'two'],
    )
    expect((await restricted.handler(chatRequest())).status).toBe(200)
    expect(restricted.asked).toEqual(['one', 'two'])
    expect(restricted.failures[0]?.failure.kind).toBe('restricted')

    const exhausted = harnessOf(
      (id) =>
        new Response(id === 'one' ? '{"code":14018,"msg":"credits exhausted"}' : 'ok', {
          status: id === 'one' ? 429 : 200,
        }),
      ['one', 'two'],
    )
    expect((await exhausted.handler(chatRequest())).status).toBe(200)
    expect(exhausted.asked).toEqual(['one', 'two'])
    expect(exhausted.failures[0]?.failure.kind).toBe('exhausted')
  })

  test('渠道拒绝（permission_error 但没有 11140）不算账号受限', async () => {
    const body = '{"error":{"message":"Illegal API invocation from an unapproved channel","type":"permission_error"}}'
    const channel = harnessOf(() => new Response(body, { status: 403 }), ['one', 'two'])
    const response = await channel.handler(chatRequest())
    /* 403 却判不出账号受限：不换号，把这份答复如实交回去 */
    expect(response.status).toBe(403)
    expect(channel.asked).toEqual(['one'])
    expect(channel.failures).toEqual([])
  })

  test('限流与请求本身出错分开：限流换号，400 原样交回', async () => {
    const limited = harnessOf(
      (id) => new Response(id === 'one' ? '{"msg":"too many requests"}' : 'ok', { status: id === 'one' ? 429 : 200 }),
      ['one', 'two'],
    )
    expect((await limited.handler(chatRequest())).status).toBe(200)
    expect(limited.failures[0]?.failure.kind).toBe('rate_limit')

    const bad = harnessOf(() => new Response('{"error":{"message":"bad tool shape"}}', { status: 400 }), ['one', 'two'])
    const response = await bad.handler(chatRequest())
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('bad tool shape')
    expect(bad.asked).toEqual(['one'])
    expect(bad.failures).toEqual([])
  })

  test('上游 5xx 换下一个账号，并把这个号报成未归类失败', async () => {
    const h = harnessOf(
      (id) => new Response(id === 'one' ? 'gateway blew up' : 'ok', { status: id === 'one' ? 502 : 200 }),
      ['one', 'two'],
    )
    const response = await h.handler(chatRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(h.asked).toEqual(['one', 'two'])
    expect(h.failures[0]?.failure).toMatchObject({ kind: 'unknown', status: 502 })
  })

  test('上游网络异常换下一个账号', async () => {
    const seen: string[] = []
    const handler = createWorkBuddyProxyHandler({
      secret: SECRET,
      accounts: async () => ({
        accounts: ['one', 'two'].map((id) => ({
          id,
          session: sessionOf(async () => {
            seen.push(id)
            if (id === 'one') throw new Error('ECONNRESET')
            return new Response('ok', { status: 200 })
          }),
        })),
      }),
      models: () => MODELS,
      upstream: 'https://upstream.test/v2/chat/completions',
    })
    const response = await handler(chatRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(seen).toEqual(['one', 'two'])
  })

  test('客户端取消时不换下一个账号，也不把失败记到这个号上', async () => {
    const asked: string[] = []
    const failures: WorkBuddyAccountFailure[] = []
    const handler = createWorkBuddyProxyHandler({
      secret: SECRET,
      accounts: async () => ({
        accounts: ['one', 'two'].map((id) => ({
          id,
          session: sessionOf(async (request) => {
            asked.push(id)
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (request.signal.aborted) throw new Error('aborted')
            return new Response('ok', { status: 200 })
          }),
        })),
      }),
      models: () => MODELS,
      onAccountFailure: (_accountId, failure) => failures.push(failure),
      upstream: 'https://upstream.test/v2/chat/completions',
    })
    const controller = new AbortController()
    const request = new Request(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"deepseek-v4.1-flash"}',
      signal: controller.signal,
    })
    const pending = handler(request)
    /* 让请求先真的打到第一个账号，再取消：这正是用户按「停止」时那一刻的样子 */
    await new Promise((resolve) => setTimeout(resolve, 1))
    controller.abort()
    const response = await pending
    expect(response.status).toBe(499)
    expect(asked).toEqual(['one'])
    expect(failures).toEqual([])
  })

  test('429 里写着恢复时刻时按它报出来', async () => {
    const body = JSON.stringify({ code: 429, msg: '请求太频繁，将在 2026-11-02 19:17:02 UTC+8 重置' })
    const h = harnessOf(
      (id) => new Response(id === 'one' ? body : 'ok', { status: id === 'one' ? 429 : 200 }),
      ['one', 'two'],
    )
    expect((await h.handler(chatRequest())).status).toBe(200)
    /* 19:17:02 +08:00 = 11:17:02Z */
    expect(h.failures[0]?.failure.resetAt).toBe(Date.UTC(2026, 10, 2, 11, 17, 2))
    expect(h.failures[0]?.failure.model).toBe('deepseek-v4.1-flash')
  })

  test('X-Magpie-Sign-In 转成失败语义后从响应上摘掉', async () => {
    const kept = harnessOf(
      () =>
        new Response('{"error":{"message":"not this route"}}', {
          status: 401,
          headers: { 'x-magpie-sign-in': 'kept', 'content-type': 'application/json' },
        }),
      ['only'],
    )
    const response = await kept.handler(chatRequest())
    expect(response.status).toBe(401)
    expect(response.headers.get('x-magpie-sign-in')).toBeNull()
    expect(kept.failures[0]?.failure.signIn).toBe('kept')

    const renewed = harnessOf(
      () => new Response('ok', { status: 200, headers: { 'x-magpie-sign-in': 'renewed' } }),
      ['only'],
    )
    const ok = await renewed.handler(chatRequest())
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-magpie-sign-in')).toBeNull()
  })

  test('上游解压过的响应不再带 content-encoding，下一跳不会二次解压', async () => {
    /* Bun 的 fetch 自动解压但保留 content-encoding 头：原样转出去下一跳就是 ZlibError */
    const h = harnessOf(
      () =>
        new Response('data: ok\n\n', {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'content-encoding': 'gzip',
            'content-length': '11',
          },
        }),
    )
    const response = await h.handler(chatRequest())
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.text()).toBe('data: ok\n\n')
  })

  test('cookie 与认证挑战头不交给 omp', async () => {
    const h = harnessOf(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'vendor_session=secret',
            'www-authenticate': 'Bearer realm="copilot"',
          },
        }),
    )
    const response = await h.handler(chatRequest())
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(await response.text()).toBe('{"ok":true}')
  })

  test('会话头透传给上游插件，不出现在别的请求里', async () => {
    const h = harnessOf(() => new Response('ok', { status: 200 }))
    await h.handler(chatRequest({ headers: { 'x-conversation-id': 'conv-1' } }))
    expect(h.seen[0]?.headers.get('x-magpie-workbuddy-session')).toBe('conv-1')
    expect(h.seen[0]?.headers.get('x-conversation-id')).toBeNull()

    const plain = harnessOf(() => new Response('ok', { status: 200 }))
    await plain.handler(chatRequest())
    expect(plain.seen[0]?.headers.get('x-magpie-workbuddy-session')).toBeNull()
  })

  test('绘图端点回一句人话，不是裸 404', async () => {
    const h = harnessOf(() => new Response('ok'))
    const response = await h.handler(new Request(`${BASE}/images/generations`, { method: 'POST', body: '{}' }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('不提供绘图')
  })

  test('handler 抛错时回 JSON 而不是带口令路径的 HTML 错误页', async () => {
    const handler = createWorkBuddyProxyHandler({
      secret: SECRET,
      accounts: async () => ({ accounts: [] }),
      models: () => {
        throw new Error('boom')
      },
    })
    const response = await handler(new Request(`${BASE}/models`))
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.text()).not.toContain(SECRET)
  })
})
