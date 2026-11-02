import { describe, expect, test } from 'bun:test'
import { createWorkBuddyProxyHandler, type WorkBuddyAccountFailure, type WorkBuddyProxyOptions } from '../proxy'
import type { WorkBuddySession } from '../types'

const SECRET = 'workbuddy-test-secret'
const BASE = `http://127.0.0.1/p/${SECRET}/v1`
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
  readonly asked: string[]
}

function harnessOf(
  answer: (accountId: string) => Response | Promise<Response>,
  accountIds: readonly string[] = ['a'],
): Harness {
  const failures: { accountId: string; failure: WorkBuddyAccountFailure }[] = []
  const asked: string[] = []
  const options: WorkBuddyProxyOptions = {
    secret: SECRET,
    accounts: async () =>
      accountIds.map((id) => ({
        id,
        session: sessionOf(async () => {
          asked.push(id)
          return await answer(id)
        }),
      })),
    models: () => MODELS,
    onAccountFailure: (accountId, failure) => failures.push({ accountId, failure }),
    upstream: 'https://upstream.test/v2/chat/completions',
  }
  return { handler: createWorkBuddyProxyHandler(options), failures, asked }
}

function chatRequest(): Request {
  return new Request(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true }),
  })
}

describe('WorkBuddy 本地反代', () => {
  test('只接受带口令的 chat 路径，并原样转发请求体', async () => {
    const seen: string[] = []
    const handler = createWorkBuddyProxyHandler({
      secret: SECRET,
      accounts: async () => [
        {
          id: 'a',
          session: sessionOf(async (request) => {
            seen.push(await request.text())
            return new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
          }),
        },
      ],
      models: () => MODELS,
      upstream: 'https://upstream.test/v2/chat/completions',
    })

    const response = await handler(chatRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: ok\n\n')
    expect(JSON.parse(seen[0] ?? '{}')).toEqual({ model: 'deepseek-v4.1-flash', stream: true })

    const wrong = new Request(`${BASE.replace(SECRET, 'wrong')}/chat/completions`, { method: 'POST', body: '{}' })
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
    expect(h.failures).toEqual([{ accountId: 'first', failure: { kind: 'sign_in', status: 401, signIn: null } }])
  })

  test('没有账号时返回 401，模型目录不需要账号', async () => {
    const h = harnessOf(() => new Response('ok'), [])
    expect((await h.handler(chatRequest())).status).toBe(401)
    const models = await h.handler(new Request(`${BASE}/models`))
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

  test('限流与请求本身出错分开：限流换号，400 原样交回', async () => {
    const limited = harnessOf(
      (id) =>
        new Response(id === 'one' ? '{"msg":"too many requests"}' : 'ok', {
          status: id === 'one' ? 429 : 200,
        }),
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

  test('上游网络异常换下一个账号', async () => {
    const seen: string[] = []
    const handler = createWorkBuddyProxyHandler({
      secret: SECRET,
      accounts: async () =>
        ['one', 'two'].map((id) => ({
          id,
          session: sessionOf(async () => {
            seen.push(id)
            if (id === 'one') throw new Error('ECONNRESET')
            return new Response('ok', { status: 200 })
          }),
        })),
      models: () => MODELS,
      upstream: 'https://upstream.test/v2/chat/completions',
    })
    const response = await handler(chatRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(seen).toEqual(['one', 'two'])
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

  test('handler 抛错时回 JSON 而不是带口令路径的 HTML 错误页', async () => {
    const handler = createWorkBuddyProxyHandler({
      secret: SECRET,
      accounts: async () => [],
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
