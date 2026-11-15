import { describe, expect, test } from 'bun:test'
import { _internal } from '../plugin/workbuddy'
import { createSession } from '../session'
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

interface Seen {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** 拦掉上游的 fetch；按路径给答复，其余一律空对象。 */
function stubFetch(answer: (path: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const real = globalThis.fetch
  const seen: Seen[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push({ url, init })
    return await answer(new URL(url).pathname, init)
  }) as typeof fetch
  return {
    seen,
    restore: () => {
      globalThis.fetch = real
    },
  }
}

const EMPTY = () => Response.json({ code: 0, data: null })

describe('WorkBuddy 会话', () => {
  test('客户端取消会传到上游 fetch 的 signal 上', async () => {
    const stub = stubFetch((path) =>
      path.endsWith('/chat/completions') ? new Response('data: ok\n\n', { status: 200 }) : EMPTY(),
    )
    try {
      const session = await createSession(CREDENTIALS, { onUpdate: () => undefined })
      const controller = new AbortController()
      controller.abort()
      const request = new Request('https://copilot.tencent.com/v2/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
        signal: controller.signal,
      })
      await session.fetch(request)
      const upstream = stub.seen.filter((entry) => entry.url.endsWith('/chat/completions')).at(-1)
      expect(upstream?.init?.signal).toBeDefined()
      expect(upstream?.init?.signal?.aborted).toBe(true)
    } finally {
      stub.restore()
    }
  })

  test('积分窗口带上 0.2.13 的 aside / runsOut / notModels', async () => {
    const stub = stubFetch((path) => {
      if (path.endsWith('/billing/meter/get-user-resource-summary')) {
        return Response.json({
          code: 0,
          data: {
            IsPaidUser: true,
            Packages: [
              /* 套餐积分：这一格已经用光 */
              { PackageCode: 'TCACA_code_002_AkiJS3ZHF5', CycleTotalCapacity: '160', CycleUsedCapacity: '160' },
              /* 活动积分：还剩，于是这一格被标成「摆着看」 */
              { PackageCode: 'TCACA_code_001_PqouKr6QWV', CycleTotalCapacity: '40', CycleUsedCapacity: '0' },
            ],
          },
        })
      }
      return EMPTY()
    })
    try {
      const session = await createSession(CREDENTIALS, { onUpdate: () => undefined })
      const usage = await session.usage()
      expect(usage.windows.length).toBeGreaterThan(0)
      const credits = usage.windows.find((window) => window.name === 'Credits')
      const extra = usage.windows.find((window) => window.name === 'Extra credits')
      expect(credits).toBeDefined()
      expect(extra).toBeDefined()
      /* 0.2.13 把套餐与额外积分拆成两格，只有一格会拦住账号 */
      expect([credits?.aside, extra?.aside]).toContain(true)
      expect([credits?.aside, extra?.aside]).toContain(false)
      /* 契约里这三格是必填：漏了就是 undefined 走进界面 */
      for (const window of usage.windows) {
        expect(typeof window.aside).toBe('boolean')
        expect(window).toHaveProperty('runsOut')
        expect(window).toHaveProperty('notModels')
      }
    } finally {
      stub.restore()
    }
  })
})

/* 免费模型那一格（0.2.14 / 0.2.24）：本机账本求和出来的读数是估算，标 aside 只摆着看；
 * 上游真写过拒绝的那一格才是精确的，才参与「这个号停不停」（XiaoFeiyu9 #641）。 */
describe('免费模型窗口的两种读法', () => {
  const NOW = Date.UTC(2026, 10, 15, 6, 0, 0)
  const row = (extra: Record<string, unknown>) => ({
    provider: 'workbuddy',
    providerAccount: 'acct',
    model: 'deepseek-v4.1-flash',
    t: new Date(NOW - 3_600_000).toISOString(),
    in: 5_000_000,
    cache_read: 0,
    out: 500_000,
    ...extra,
  })

  test('只有账本求和时，这一格是估算且不拦账号', () => {
    const rows = [row({ status: 200 })]
    const card = _internal.freeWindowOf(rows, 'acct', NOW, _internal.FREE_WINDOW_CN)
    expect(card).not.toBeNull()
    expect(card?.aside).toBe(true)
    expect(card?.refused).toBeUndefined()
    /* 估算的名字自己说是估算；上限是中国站实测出来的 2e8 */
    expect(card?.name).toContain('est.')
    expect(card?.limit).toBe(2e8)
  })

  test('上游写过拒绝时，那一格是精确的，且不当成估算', () => {
    const rows = [
      row({ status: 200 }),
      row({
        status: 429,
        t: new Date(NOW - 60_000).toISOString(),
        err: 'WorkBuddy: 您的使用量已超出频率限制，将在 2026-11-15 15:00:00 UTC+8 重置，您也可以切换其他模型继续使用。',
      }),
    ]
    const card = _internal.freeWindowOf(rows, 'acct', NOW, _internal.FREE_WINDOW_CN)
    expect(card?.refused).toBe(true)
    expect(card?.aside).toBeUndefined()
    expect(card?.name).toBe('Free model tokens')
    /* 重置时刻就是上游写的那一个 */
    expect(card?.resetsAt).toBe(new Date(Date.UTC(2026, 10, 15, 7, 0, 0)).toISOString())
  })
})
