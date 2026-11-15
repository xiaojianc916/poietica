import { describe, expect, test } from 'bun:test'
import type { Chat } from '../plugin/types'
import { _internal } from '../plugin/workbuddy'

/* 与上游 0.2.14 / 0.2.15 / 0.2.21 / 0.2.34 对齐的三条请求侧规则。
 * 每一条都对应一次真实拒绝或一次被烧空的预算，理由写在 workbuddy.ts 里那几段注释上。 */

describe('REA 的代理项守卫（0.2.34, #1080）', () => {
  /* REA 的原样：一条独立的守卫，外加落在 allOf 与 items 里的同一串。 */
  const GUARD = '^[^\\uD800-\\uDFFF]*$'

  const tool = (parameters: unknown) => ({
    model: 'deepseek-v4.1-flash-sg',
    messages: [{ role: 'user', content: 'run it' }],
    tools: [{ type: 'function', function: { name: 'mcp__rea__binary_session', parameters } }],
  })

  interface PathSchema {
    type?: string
    minLength?: number
    pattern?: string
    allOf?: { pattern?: string }[]
  }

  interface SentSchema {
    properties: { expected_server_path: PathSchema; paths: { type?: string; items?: PathSchema } }
    additionalProperties?: boolean
  }

  function sent(parameters: unknown): SentSchema {
    const out = _internal.fitted(JSON.stringify(tool(parameters)))
    const body = JSON.parse(String(out.body)) as { tools: { function: { parameters: SentSchema } }[] }
    return body.tools[0]!.function.parameters
  }

  test('一模一样的那串从 schema 里去掉，邻居的约束一个不动', () => {
    const parameters = {
      type: 'object',
      properties: {
        expected_server_path: {
          type: 'string',
          minLength: 1,
          allOf: [
            { pattern: '^[^\\x00]*$' },
            { pattern: GUARD },
            { pattern: '^(?:[\\x5C\\x2F]|[A-Za-z]:[\\x5C\\x2F])' },
          ],
        },
        paths: { type: 'array', items: { type: 'string', pattern: GUARD } },
      },
      additionalProperties: false,
    }
    const schema = sent(parameters)
    const path = schema.properties.expected_server_path
    /* 守卫那一条降级成空 schema，前后的约束与顺序都还在 */
    expect(path.allOf?.[1]).toEqual({})
    expect(path.allOf?.[0]).toEqual({ pattern: '^[^\\x00]*$' })
    expect(path.allOf?.[2]).toEqual({ pattern: '^(?:[\\x5C\\x2F]|[A-Za-z]:[\\x5C\\x2F])' })
    expect(path.pattern).toBeUndefined()
    expect(path.type).toBe('string')
    expect(path.minLength).toBe(1)
    expect(schema.properties.paths.items).toEqual({ type: 'string' })
    expect(schema.additionalProperties).toBe(false)
    /* 调用方的对象不被改写 */
    expect(parameters.properties.paths.items.pattern).toBe(GUARD)
  })

  test('别的代理项写法和字面量转义都原样留着', () => {
    const body = JSON.stringify(
      tool({
        type: 'object',
        properties: {
          mixed: { type: 'string', pattern: '^[^\\u0000\\uD800-\\uDFFF]*$' },
          literal: { type: 'string', pattern: '^[^\\\\uD800-\\\\uDFFF]*$' },
          ordinary: { type: 'string', pattern: '^[a-z]+$' },
        },
      }),
    )
    expect(_internal.fitted(body).body).toBe(body)
  })
})

describe('小预算不补默认思考档（0.2.15, #643）', () => {
  const list = [{ id: 'deepseek-v4.1-flash', effort: 'high' }]

  test('max_tokens 不超过 1024 的请求拿不到默认档', () => {
    for (const limit of [32, 512, 1024]) {
      const chat: Chat = { model: 'deepseek-v4.1-flash', max_tokens: limit, messages: [] }
      expect(_internal.withDefaultEffort(chat, list)).toBe(false)
      expect(chat.reasoning_effort).toBeUndefined()
    }
  })

  test('两种写法的小预算都算数', () => {
    const chat: Chat = { model: 'deepseek-v4.1-flash', max_completion_tokens: 64, messages: [] }
    expect(_internal.withDefaultEffort(chat, list)).toBe(false)
    expect(chat.reasoning_effort).toBeUndefined()
  })

  test('正常预算照旧补上默认档，客户端自己点过的档位一个字节不动', () => {
    const roomy: Chat = { model: 'deepseek-v4.1-flash', max_tokens: 4096, messages: [] }
    expect(_internal.withDefaultEffort(roomy, list)).toBe(true)
    expect(roomy.reasoning_effort).toBe('high')

    /* 没写预算的请求也照旧：没有证据表明它是短活 */
    const silent: Chat = { model: 'deepseek-v4.1-flash', messages: [] }
    expect(_internal.withDefaultEffort(silent, list)).toBe(true)

    /* 客户端点过 none 就是 none，不被默认档盖掉 */
    const chosen: Chat = { model: 'deepseek-v4.1-flash', max_tokens: 4096, reasoning_effort: 'none', messages: [] }
    expect(_internal.withDefaultEffort(chosen, list)).toBe(false)
    expect(chosen.reasoning_effort).toBe('none')
  })
})

describe('登录页用桌面端版本打开（0.2.21）', () => {
  test('version 是站点自己的 app 版本，不是写死的 2.0.0', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json({
        code: 0,
        data: { state: 'st-1', authUrl: 'https://copilot.tencent.com/login?from=plugin' },
      })) as unknown as typeof fetch
    try {
      const signIn = await _internal.browserSignIn(_internal.SITES.workbuddy!)
      const url = new URL(signIn.url)
      expect(url.searchParams.get('version')).toBe(_internal.SITES.workbuddy!.app)
      /* 中国站这一页对 version < 5.8.0 会藏掉企业微信登录 */
      expect(Number(url.searchParams.get('version')?.split('.')[0])).toBeGreaterThanOrEqual(5)
      expect(url.searchParams.get('loginSessionId')?.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = real
    }
  })
})
