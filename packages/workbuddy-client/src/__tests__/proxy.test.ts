import { describe, expect, test } from 'bun:test'
import { createWorkBuddyProxyHandler, type WorkBuddyProxyOptions } from '../proxy'
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

function handlerOf(
  accounts: WorkBuddyProxyOptions['accounts'],
  onAuthFailure?: (accountId: string, status: number) => void,
): (request: Request) => Promise<Response> {
  return createWorkBuddyProxyHandler({
    secret: SECRET,
    accounts,
    models: () => MODELS,
    onAuthFailure,
    upstream: 'https://upstream.test/v2/chat/completions',
  })
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
    const handler = handlerOf(async () => [
      {
        id: 'a',
        session: sessionOf(async (request) => {
          seen.push(await request.text())
          return new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }),
      },
    ])

    const response = await handler(chatRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: ok\n\n')
    expect(JSON.parse(seen[0] ?? '{}')).toEqual({ model: 'deepseek-v4.1-flash', stream: true })

    const wrong = new Request(`${BASE.replace(SECRET, 'wrong')}/chat/completions`, { method: 'POST', body: '{}' })
    expect((await handler(wrong)).status).toBe(404)
  })

  test('首选账号 401 时换下一个账号，并把失败的账号交回宿主', async () => {
    const failed: string[] = []
    const calls: string[] = []
    const handler = handlerOf(
      async () => [
        {
          id: 'first',
          session: sessionOf(async () => {
            calls.push('first')
            return new Response('denied', { status: 401 })
          }),
        },
        {
          id: 'second',
          session: sessionOf(async () => {
            calls.push('second')
            return new Response('ok', { status: 200 })
          }),
        },
      ],
      (id) => failed.push(id),
    )

    const response = await handler(chatRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(calls).toEqual(['first', 'second'])
    expect(failed).toEqual(['first'])
  })

  test('没有账号时返回 401，模型目录不需要账号', async () => {
    const handler = handlerOf(async () => [])
    expect((await handler(chatRequest())).status).toBe(401)
    const models = await handler(new Request(`${BASE}/models`))
    expect(models.status).toBe(200)
    expect(await models.json()).toMatchObject({ data: [{ id: 'deepseek-v4.1-flash' }] })
  })
})
