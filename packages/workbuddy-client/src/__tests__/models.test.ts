import { describe, expect, test } from 'bun:test'
import { listModels } from '../session'
import type { WorkBuddyCredentials } from '../types'

const CREDENTIALS: WorkBuddyCredentials = {
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 3_600_000,
  refreshExpiresAt: 0,
  uid: 'uid-1',
  accountId: 'acct',
  domain: 'copilot.tencent.com',
  tokenType: 'Bearer',
  enterpriseId: '',
  key: '',
}

/** 拦掉上游的 fetch；/v3/config 给一份实时目录，其余一律空对象。 */
function stubFetch(config: unknown | (() => Response)) {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).pathname === '/v3/config') {
      return typeof config === 'function' ? (config as () => Response)() : Response.json(config)
    }
    return Response.json({ code: 0, data: null })
  }) as unknown as typeof fetch
  return {
    restore: () => {
      globalThis.fetch = real
    },
  }
}

describe('WorkBuddy 模型目录', () => {
  test('没有账号时用插件里的静态表', async () => {
    const models = await listModels()
    const deepseek = models.find((model) => model.id === 'deepseek-v4.1-flash')
    expect(deepseek).toBeDefined()
    expect(deepseek?.api).toBe('chat')
    expect(deepseek?.contextWindow).toBeGreaterThan(0)
    expect(models.every((model) => model.id !== '')).toBe(true)
  })

  test('0.2.13 的目录里带思考档位的模型仍然可读', async () => {
    const models = await listModels()
    /* deepseek-v4.1-flash 在 0.2.7 起就有 none/low/high/max 四档 */
    const deepseek = models.find((model) => model.id === 'deepseek-v4.1-flash')
    expect(deepseek?.reasoning).toBe(true)
    /* 静态表里只有 chat，Messages 路留给实时目录 */
    expect(models.every((model) => model.api === 'chat')).toBe(true)
  })

  test('有账号时用上游自己的目录，静态表里没有的模型也在', async () => {
    const stub = stubFetch({
      code: 0,
      data: {
        agents: [{ name: 'cli', models: ['deepseek-v4.1-flash', 'glm-6-preview', 'claude-opus-5.5'] }],
        models: [
          {
            id: 'deepseek-v4.1-flash',
            name: 'Deepseek-V4.1-Flash',
            maxInputTokens: 1000000,
            maxOutputTokens: 128000,
            supportsImages: true,
          },
          /* 上游新上、静态表里还没有的模型 */
          { id: 'glm-6-preview', name: 'GLM-6 Preview', maxInputTokens: 800000, maxOutputTokens: 64000 },
          /* Claude 系走 Messages */
          { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', maxInputTokens: 200000, maxOutputTokens: 32000 },
        ],
      },
    })
    try {
      const models = await listModels(CREDENTIALS)
      const ids = models.map((model) => model.id)
      /* 实时表是唯一的来源：静态表里多出来的 auto / hy3 不该出现 —— 那是兜底，不是叠加 */
      expect(ids).toEqual(['deepseek-v4.1-flash', 'glm-6-preview', 'claude-opus-5.5'])
      expect(models.find((model) => model.id === 'glm-6-preview')?.contextWindow).toBe(800000)
      /* 两条协议按模型分 */
      expect(models.find((model) => model.id === 'claude-opus-5.5')?.api).toBe('messages')
      expect(models.find((model) => model.id === 'deepseek-v4.1-flash')?.api).toBe('chat')
      expect(models.find((model) => model.id === 'deepseek-v4.1-flash')?.vision).toBe(true)
    } finally {
      stub.restore()
    }
  })

  test('上游答不上来时退回静态表，不把目录读空', async () => {
    const stub = stubFetch(() => Response.json({ code: 500, msg: 'boom' }, { status: 500 }))
    try {
      const models = await listModels(CREDENTIALS)
      expect(models.map((model) => model.id)).toContain('deepseek-v4.1-flash')
    } finally {
      stub.restore()
    }
  })

  test('上游给了一张空表时也退回静态表', async () => {
    const stub = stubFetch({ code: 0, data: { agents: [], models: [] } })
    try {
      const models = await listModels(CREDENTIALS)
      expect(models.map((model) => model.id)).toContain('deepseek-v4.1-flash')
    } finally {
      stub.restore()
    }
  })
})
