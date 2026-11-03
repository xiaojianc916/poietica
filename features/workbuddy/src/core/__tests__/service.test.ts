import { describe, expect, test } from 'bun:test'
import type { ModelsPort } from '@poietica/engine'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger } from '@poietica/test-kit'
import type {
  WorkBuddyCheckin,
  WorkBuddyProxyOptions,
  WorkBuddySession,
  WorkBuddyUsage,
} from '@poietica/workbuddy-client'
import { migrations } from '../migrations'
import { type AccountRecord, createWorkBuddyRepository } from '../repository'
import { createWorkBuddyService } from '../service'

/* 2026-11-01 12:00 北京 = 04:00Z：签到「当天 12 点」的分界正好在这一刻 */
const NOW = Date.UTC(2026, 10, 1, 4, 0, 0)

function usageOf(overrides: Partial<WorkBuddyUsage> = {}): WorkBuddyUsage {
  return { plan: 'Free plan', windows: [], signIn: 'kept', error: null, ...overrides }
}

const SESSION: WorkBuddySession = {
  fetch: async () => new Response('{}'),
  usage: async () => usageOf(),
  checkin: async () => ({ outcome: 'claimed', credit: 5, streak: 2, message: null }),
  validate: async () => undefined,
}

interface Harness {
  readonly repository: ReturnType<typeof createWorkBuddyRepository>
  readonly service: ReturnType<typeof createWorkBuddyService>
  readonly logins: Map<string, unknown>
  /** 上一次 startProxy 拿到的选项：测试用它直接触发失败回调 */
  readonly proxyOptions: () => WorkBuddyProxyOptions | null
  readonly now: () => number
  readonly setNow: (value: number) => void
  readonly close: () => void
  /** 写进模型目录的自定义服务商（每次 upsert 一份） */
  readonly providers: { id: string; name: string; baseUrl: string; custom?: boolean }[]
  readonly setProviders: (value: { id: string; name: string; custom: boolean }[]) => void
}

interface SeedOptions {
  readonly clock?: () => number
  /** 模型目录里已经有的服务商（模拟上一次启动留下的旧条目） */
  readonly providers?: { id: string; name: string; custom: boolean }[]
  /** 建服务前就要写好的设置（服务在构造时读一次） */
  readonly settings?: Record<string, string>
}

function seed(
  record: Partial<AccountRecord> = {},
  session: Partial<WorkBuddySession> = {},
  options: SeedOptions = {},
): Harness {
  const db = openDatabase(':memory:')
  const moduleDb = db.forModule('workbuddy')
  for (const migration of migrations) moduleDb.exec(migration.sql)
  const repository = createWorkBuddyRepository(moduleDb)
  repository.insert({
    id: 'a1',
    label: '稻黄草',
    authType: 'oauth',
    access: 'access',
    refresh: 'refresh',
    expires: NOW + 60_000,
    refreshExpiresAt: NOW + 120_000,
    uid: 'u1',
    domain: 'cn',
    tokenType: 'Bearer',
    enterpriseId: '',
    apiKey: '',
    plan: 'Free plan',
    status: 'ok',
    statusMessage: null,
    usageJson: JSON.stringify({
      plan: 'Free plan',
      windows: [
        {
          name: 'Credits',
          used: 7.5,
          amount: 12,
          limit: 160,
          balance: null,
          unit: 'credits',
          display: '12 / 160',
          resetsAt: '2026-11-03T00:00:00.000Z',
          runsOutAt: null,
          span: null,
          models: null,
          refused: false,
          aside: false,
          runsOut: null,
          notModels: null,
        },
      ],
      signIn: 'kept',
      error: null,
    }),
    usageAt: NOW,
    restUntil: 0,
    restReason: null,
    checkin: { day: '2026-11-01', at: NOW, outcome: 'claimed', message: null, credit: 5, streak: 2, nextTryAt: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...record,
  })
  const written: { id: string; name: string; baseUrl: string; custom?: boolean }[] = []
  let catalog = options.providers ?? []
  const models = {
    providers: async () => catalog,
    upsertCustomProvider: async (def: { id: string; name: string; baseUrl: string }) => {
      written.push(def)
    },
    removeCustomProvider: async () => undefined,
  } as unknown as ModelsPort
  for (const [key, value] of Object.entries(options.settings ?? {})) repository.setSetting(key, value)
  let clock = options.clock?.() ?? NOW
  let proxyOptions: WorkBuddyProxyOptions | null = null
  const service = createWorkBuddyService({
    repository,
    models,
    logger: createTestLogger(),
    now: () => clock,
    emitChanged: () => undefined,
    emitLogin: () => undefined,
    startProxy: (given) => {
      proxyOptions = given
      return { port: 1234, baseUrl: 'http://127.0.0.1:1234/p/secret/v1', stop: () => undefined }
    },
    openSession: async () => ({ ...SESSION, ...session }),
  })
  return {
    repository,
    service,
    logins: new Map(),
    proxyOptions: () => proxyOptions,
    now: () => clock,
    setNow: (value) => {
      clock = value
    },
    close: () => db.close(),
    providers: written,
    setProviders: (value) => {
      catalog = value
    },
  }
}

/* 自动签到是 fire-and-forget（RPC 要立刻回快照），测试里得让它跑完再断言 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 让服务把反代跑起来，拿到 proxy 的选项（回调都在上面）。 */
async function started(h: Harness): Promise<WorkBuddyProxyOptions> {
  await h.service.setEnabled(true)
  const options = h.proxyOptions()
  if (options === null) throw new Error('反代没有启动')
  return options
}

describe('WorkBuddy Core 服务', () => {
  test('快照把积分、套餐、首选与签到放在账号视图上', () => {
    const { close, service } = seed()
    service.setPreferred('a1')
    const snapshot = service.snapshot()
    expect(snapshot.accounts[0]).toMatchObject({
      label: '稻黄草',
      plan: 'Free plan',
      preferred: true,
      checkedInToday: true,
      kind: 'browser',
    })
    expect(snapshot.accounts[0]?.usage?.windows[0]?.display).toBe('12 / 160')
    expect(snapshot.accounts[0]?.checkin?.credit).toBe(5)
    close()
  })

  test('升级前存下的 usage_json 缺 aside/runsOut/notModels，仍能读出积分', () => {
    /* 真实的老记录：除了新加的三格，其余字段都在（升级前那一版就是这么写进去的）*/
    const legacy = JSON.stringify({
      plan: 'Free plan',
      windows: [
        {
          name: 'Credits',
          used: 7.5,
          amount: 12,
          limit: 160,
          balance: null,
          unit: 'credits',
          display: '12 / 160',
          resetsAt: null,
          runsOutAt: null,
          span: null,
          models: null,
          refused: false,
        },
      ],
      signIn: null,
      error: null,
    })
    const { close, repository, service } = seed({ usageJson: legacy })
    expect(repository.get('a1')?.usageJson).toBe(legacy)
    const window = service.snapshot().accounts[0]?.usage?.windows[0]
    expect(window?.display).toBe('12 / 160')
    expect(window).toMatchObject({ aside: false, runsOut: null, notModels: null })
    close()
  })

  test('移除首选后自动换下一个账号；没有账号时反代退回 missing', async () => {
    const { close, repository, service } = seed()
    repository.setSetting('preferred_account_id', 'a1')
    await service.removeAccount('a1')
    expect(service.snapshot().accounts).toEqual([])
    expect(service.snapshot().proxy.providerState).toBe('missing')
    close()
  })

  test('API Key 账号的签到是 ineligible，不调用上游', async () => {
    const { close, service } = seed({
      id: 'key',
      authType: 'api',
      access: 'ck_12345678',
      refresh: '',
      uid: 'anonymous_12345678',
      apiKey: 'ck_12345678',
      checkin: null,
    })
    const result = await service.checkin('key')
    expect(result).toMatchObject({ outcome: 'ineligible', message: 'API Key 账号不参与签到' })
    expect(service.snapshot().accounts[0]?.checkedInToday).toBe(false)
    close()
  })
})

describe('WorkBuddy 反代与模型目录', () => {
  test('冲突分支也把新地址写回模型目录，不让 omp 打到死端口', async () => {
    /* 上一版留下的自己的条目，但名字被人改过：认领不了，只能算冲突 */
    const h = seed(
      {},
      {},
      {
        providers: [{ id: 'workbuddy', name: '改过名的 WorkBuddy', custom: true }],
        settings: { provider_registered: '1' },
      },
    )
    const enabled = await h.service.setEnabled(true)
    expect(enabled.proxy.providerState).toBe('conflict')
    /* 反代在跑着（换了新端口），目录里那条必须跟着指向新地址 */
    expect(enabled.proxy).toMatchObject({ running: true, port: 1234 })
    expect(h.providers.at(-1)).toMatchObject({
      id: 'workbuddy',
      baseUrl: 'http://127.0.0.1:1234/p/secret/v1',
    })
    h.close()
  })

  test('不是自己注册的条目在冲突时不改写', async () => {
    const h = seed({}, {}, { providers: [{ id: 'workbuddy', name: '别人的', custom: true }] })
    await h.service.setEnabled(true)
    expect(h.providers).toEqual([])
    h.close()
  })

  test('自己那一份被别人占了名字时会收养并写回地址', async () => {
    const h = seed({}, {}, { providers: [{ id: 'workbuddy', name: 'WorkBuddy', custom: true }] })
    const enabled = await h.service.setEnabled(true)
    expect(enabled.proxy.providerState).toBe('registered')
    expect(h.providers.at(-1)).toMatchObject({ baseUrl: 'http://127.0.0.1:1234/p/secret/v1' })
    expect(h.repository.settings().provider_registered).toBe('1')
    h.close()
  })
})

describe('WorkBuddy 账号休息状态机', () => {
  test('受限的账号歇 2 小时；都歇着时报「最早回来的时刻」而不是伪造的未登录', async () => {
    const h = seed()
    const options = await started(h)
    options.onAccountFailure?.('a1', { kind: 'restricted', status: 403, signIn: null })
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 2 * 60 * 60 * 1000)

    /*
     * 全都歇着：名单是空的，但带着「最早什么时候回来」。反代据此回 429 + Retry-After，
     * 而不是 401「还没有登录」—— 后者会让用户去重新登录一个没坏的号。
     */
    const resting = await options.accounts()
    expect(resting.accounts).toEqual([])
    expect(resting.restingUntil).toBe(NOW + 2 * 60 * 60 * 1000)

    /* 歇够了就回来 */
    h.setNow(NOW + 2 * 60 * 60 * 1000 + 1)
    expect((await options.accounts()).accounts.map((account) => account.id)).toEqual(['a1'])
    h.close()
  })

  test('都歇着时每分钟放最快回来的那个去探一次路', async () => {
    const h = seed()
    const options = await started(h)
    options.onAccountFailure?.('a1', { kind: 'restricted', status: 403, signIn: null })
    expect((await options.accounts()).accounts).toEqual([])

    /* 一分钟后再问：放它去上游试一次，成功就自然解除休息 */
    h.setNow(NOW + 61_000)
    const probed = await options.accounts()
    expect(probed.accounts.map((account) => account.id)).toEqual(['a1'])
    expect(probed.restingUntil).toBeUndefined()

    /* 刚探过，下一个请求不再探，免得把「一次误判」变成每分钟一次撞墙 */
    h.setNow(NOW + 90_000)
    expect((await options.accounts()).accounts).toEqual([])
    h.close()
  })

  test('限流 1 分钟起、连续命中翻倍，封顶 30 分钟；成功一次就清零', async () => {
    const h = seed()
    const options = await started(h)
    const failure = { kind: 'rate_limit', status: 429, signIn: null } as const
    options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 60_000)
    options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 2 * 60_000)
    options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 4 * 60_000)

    /* 成功一次（magpie 的 served）：这个号刚证明自己是好的，阶梯从头起 */
    options.onAccountAnswered?.('a1')
    expect(h.repository.get('a1')?.restUntil).toBe(0)
    options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 60_000)

    /* 一路翻倍到顶 */
    for (let i = 0; i < 8; i++) options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 30 * 60_000)

    /* 插件刷出新令牌说明账号是好的：计数与休息都清掉 */
    options.onAccountRenewed?.('a1')
    expect(h.repository.get('a1')?.restUntil).toBe(0)
    options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 60_000)
    h.close()
  })

  test('隔了 30 分钟才再被限流，算新的一轮，从 1 分钟重新起', async () => {
    const h = seed()
    const options = await started(h)
    const failure = { kind: 'rate_limit', status: 429, signIn: null } as const
    options.onAccountFailure?.('a1', failure)
    h.setNow(NOW + 60_000 + 31 * 60_000)
    options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 60_000 + 31 * 60_000 + 60_000)
    h.close()
  })

  test('上游没归类的失败也换号歇一会儿，并按自己的阶梯翻倍', async () => {
    const h = seed()
    const options = await started(h)
    const failure = { kind: 'unknown', status: 502, signIn: null } as const
    options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 60_000)
    options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 2 * 60_000)
    for (let i = 0; i < 10; i++) options.onAccountFailure?.('a1', failure)
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 10 * 60_000)
    h.close()
  })

  test('上游给了恢复时刻就按它休息，不再按固定时长瞎猜', async () => {
    const h = seed()
    const options = await started(h)
    options.onAccountFailure?.('a1', {
      kind: 'rate_limit',
      status: 429,
      signIn: null,
      resetAt: NOW + 42 * 60_000,
    })
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 42 * 60_000)
    h.close()
  })

  test('短的失败不会把更长的休息缩短', async () => {
    const h = seed()
    const options = await started(h)
    options.onAccountFailure?.('a1', { kind: 'restricted', status: 403, signIn: null })
    const restricted = h.repository.get('a1')?.restUntil ?? 0
    options.onAccountFailure?.('a1', { kind: 'rate_limit', status: 429, signIn: null })
    expect(h.repository.get('a1')?.restUntil).toBe(restricted)
    h.close()
  })

  test('额度用尽的账号歇 30 分钟', async () => {
    const h = seed()
    const options = await started(h)
    options.onAccountFailure?.('a1', { kind: 'exhausted', status: 400, signIn: null })
    expect(h.repository.get('a1')?.restUntil).toBe(NOW + 30 * 60_000)
    h.close()
  })

  test('kept 的 401 不把账号标成失效', async () => {
    const h = seed()
    const options = await started(h)
    options.onAccountFailure?.('a1', { kind: 'sign_in', status: 401, signIn: 'kept' })
    expect(h.repository.get('a1')?.status).toBe('ok')
    expect(h.repository.get('a1')?.restUntil).toBe(0)
    h.close()
  })

  test('expired 的 401 标失效；上游没说语义时按 expired 处理', async () => {
    const explicit = seed()
    const first = await started(explicit)
    first.onAccountFailure?.('a1', { kind: 'sign_in', status: 401, signIn: 'expired' })
    expect(explicit.repository.get('a1')?.status).toBe('expired')
    explicit.close()

    const silent = seed()
    const second = await started(silent)
    second.onAccountFailure?.('a1', { kind: 'sign_in', status: 401, signIn: null })
    expect(silent.repository.get('a1')?.status).toBe('expired')
    silent.close()
  })

  test('全部账号都在休息时给最早回来的时刻，不是空手而归', async () => {
    const h = seed()
    h.repository.insert({
      ...(h.repository.get('a1') as AccountRecord),
      id: 'a2',
      uid: 'u2',
      label: '第二个',
      createdAt: NOW + 1,
    })
    const options = await started(h)
    options.onAccountFailure?.('a1', { kind: 'restricted', status: 403, signIn: null })
    options.onAccountFailure?.('a2', { kind: 'exhausted', status: 400, signIn: null })
    const handed = await options.accounts()
    expect(handed.accounts).toEqual([])
    expect(handed.restingUntil).toBe(NOW + 30 * 60_000)
    h.close()
  })
})

/*
 * 真实账号的积分记在 aside 那一格里：非 aside 的 Credits 是套餐额度（used 恒 0），
 * 真正在烧的是 aside 的 Extra credits（实测 43.13 / 7105）。所以排序必须读 aside，
 * 否则「剩余额度」这一维在绝大多数时间都是 0，排序退化成只比到期日。
 */
function usageJsonOfSpend(creditsUsed: number, extraUsed: number, runsOutAt: string): string {
  const window = (name: string, used: number, limit: number, aside: boolean) => ({
    name,
    used,
    amount: used,
    limit,
    balance: null,
    unit: 'credits',
    display: `${used} / ${limit}`,
    resetsAt: null,
    runsOutAt,
    span: null,
    models: null,
    refused: false,
    aside,
    runsOut: null,
    notModels: null,
  })
  return JSON.stringify({
    plan: 'Free plan',
    windows: [window('Credits', creditsUsed, 500, false), window('Extra credits', extraUsed, 5000, true)],
    signIn: 'kept',
    error: null,
  })
}

/* 每格积分的 runsOutAt 决定排序里的 lapse：越早到期的越先被问（先花掉，免得作废） */
function usageJsonOf(runsOutAt: string): string {
  return JSON.stringify({
    plan: 'Free plan',
    windows: [
      {
        name: 'Credits',
        used: 7.5,
        amount: 12,
        limit: 160,
        balance: null,
        unit: 'credits',
        display: '12 / 160',
        resetsAt: '2026-11-03T00:00:00.000Z',
        runsOutAt,
        span: null,
        models: null,
        refused: false,
        aside: false,
        runsOut: null,
        notModels: null,
      },
    ],
    signIn: 'kept',
    error: null,
  })
}

/** 两个号的库：a1 的积分先到期，所以不黏号时它恒排第一。 */
function seedTwo(runsOutAtA1: string, runsOutAtA2: string): Harness {
  const h = seed({ usageJson: usageJsonOf(runsOutAtA1) })
  h.repository.insert({
    ...(h.repository.get('a1') as AccountRecord),
    id: 'a2',
    uid: 'u2',
    label: '第二个',
    usageJson: usageJsonOf(runsOutAtA2),
    createdAt: NOW + 1,
  })
  return h
}

describe('WorkBuddy 会话黏号', () => {
  test('同一会话的第二个请求仍先问上次答出来的号', async () => {
    const h = seedTwo('2026-11-05T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
    const options = await started(h)
    expect((await options.accounts('conv-1')).accounts.map((account) => account.id)).toEqual(['a1', 'a2'])

    options.onAccountAnswered?.('a1', 'conv-1')
    /* 把 a1 的到期日推到 a2 后面：没有黏号的话，下一个请求就该搬家了 */
    h.repository.updateUsage('a1', 'Free plan', usageJsonOf('2026-11-20T00:00:00.000Z'), NOW, NOW)
    expect((await options.accounts('conv-1')).accounts.map((account) => account.id)).toEqual(['a1', 'a2'])
    /* 黏的是会话，不是号：别的会话照排序来 */
    expect((await options.accounts('conv-2')).accounts.map((account) => account.id)).toEqual(['a2', 'a1'])
    h.close()
  })

  test('超过黏号保鲜期就不再黏，回到按排序选', async () => {
    const h = seedTwo('2026-11-05T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
    const options = await started(h)
    options.onAccountAnswered?.('a1', 'conv-1')
    h.repository.updateUsage('a1', 'Free plan', usageJsonOf('2026-11-20T00:00:00.000Z'), NOW, NOW)

    /* 5 分钟是 magpie 的 cacheCold：上游的前缀缓存冷了，黏着也换不来命中 */
    h.setNow(NOW + 5 * 60_000)
    expect((await options.accounts('conv-1')).accounts.map((account) => account.id)).toEqual(['a1', 'a2'])
    h.setNow(NOW + 5 * 60_000 + 1)
    expect((await options.accounts('conv-1')).accounts.map((account) => account.id)).toEqual(['a2', 'a1'])
    h.close()
  })

  test('黏住的号在休息或失效时不再黏', async () => {
    const resting = seedTwo('2026-11-05T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
    const restOptions = await started(resting)
    restOptions.onAccountAnswered?.('a1', 'conv-1')
    resting.repository.updateUsage('a1', 'Free plan', usageJsonOf('2026-11-20T00:00:00.000Z'), NOW, NOW)
    /* 刚被限流：黏它等于把下一个请求送去撞一个已知还在休息的号 */
    restOptions.onAccountFailure?.('a1', { kind: 'rate_limit', status: 429, signIn: null })
    expect((await restOptions.accounts('conv-1')).accounts.map((account) => account.id)).toEqual(['a2'])
    resting.close()

    const expired = seedTwo('2026-11-05T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
    const expiredOptions = await started(expired)
    expiredOptions.onAccountAnswered?.('a1', 'conv-1')
    expired.repository.updateUsage('a1', 'Free plan', usageJsonOf('2026-11-20T00:00:00.000Z'), NOW, NOW)
    expired.repository.setStatus('a1', 'expired', 'WorkBuddy 拒绝了这次登录，请重新登录', NOW)
    /* 失效的号排序里已经排到后面了，黏号不该把它拉回第一位 */
    expect((await expiredOptions.accounts('conv-1')).accounts.map((account) => account.id)).toEqual(['a2', 'a1'])
    expired.close()
  })
})

describe('WorkBuddy 选号读 aside 积分的真实消耗', () => {
  /* 两个号的到期日相同，唯一的差别在用掉多少积分：真正在烧的是 aside 的 Extra credits */
  function seedSpend(a1Extra: number, a2Extra: number): Harness {
    const at = '2026-11-05T00:00:00.000Z'
    const h = seed({ usageJson: usageJsonOfSpend(0, a1Extra, at) })
    h.repository.insert({
      ...(h.repository.get('a1') as AccountRecord),
      id: 'a2',
      uid: 'u2',
      label: '第二个',
      usageJson: usageJsonOfSpend(0, a2Extra, at),
      createdAt: NOW + 1,
    })
    return h
  }

  test('aside 窗口用得更满的号排到后面', async () => {
    const h = seedSpend(4500, 100)
    const options = await started(h)
    /* 不给会话键：这条只看排序，不掺黏号 */
    expect((await options.accounts(undefined)).accounts.map((account) => account.id)).toEqual(['a2', 'a1'])
    h.close()
  })

  test('aside 窗口不参与 90% / 98% 的分档', async () => {
    /* a1 的 aside 用掉 99%：按已用比例它该排后面，但不该被推进 low / spent 档 */
    const h = seedSpend(4950, 5000)
    const options = await started(h)
    /* 两格的档位都还是 fine（0），所以只按已用比例排：5000/5000 比 4950/5000 更满 */
    expect((await options.accounts(undefined)).accounts.map((account) => account.id)).toEqual(['a1', 'a2'])
    h.close()
  })
})

describe('WorkBuddy 签到退避', () => {
  test('签到失败会写下一次重试时刻，30 分钟内不再自动去问', async () => {
    const timeline: number[] = []
    const h = seed(
      { checkin: null },
      {
        checkin: async () => {
          timeline.push(h.now())
          throw new Error('上游没应答')
        },
      },
    )
    await h.service.setAutoCheckin(true)
    await settle()
    expect(timeline).toHaveLength(1)
    const record = h.repository.get('a1')?.checkin
    expect(record).toMatchObject({ outcome: 'failed', nextTryAt: NOW + 30 * 60 * 1000 })

    /* 少一分钟：还没到点，不重试 */
    h.setNow(NOW + 29 * 60 * 1000)
    await h.service.setAutoCheckin(true)
    await settle()
    expect(timeline).toHaveLength(1)

    /* 到点：重试 */
    h.setNow(NOW + 30 * 60 * 1000)
    await h.service.setAutoCheckin(true)
    await settle()
    expect(timeline).toHaveLength(2)
    h.close()
  })

  test('当天签成了就不再自动问；换一天才再问', async () => {
    const timeline: number[] = []
    const h = seed(
      { checkin: null },
      {
        checkin: async () => {
          timeline.push(h.now())
          return { outcome: 'claimed', credit: 5, streak: 2, message: null } satisfies WorkBuddyCheckin
        },
      },
    )
    await h.service.setAutoCheckin(true)
    await settle()
    expect(timeline).toHaveLength(1)
    /* 同一天再触发几次都不问 */
    h.setNow(NOW + 8 * 60 * 60 * 1000)
    await h.service.setAutoCheckin(true)
    await settle()
    await h.service.setAutoCheckin(true)
    await settle()
    expect(timeline).toHaveLength(1)
    /* 第二天（北京日）再来 */
    h.setNow(NOW + 24 * 60 * 60 * 1000)
    await h.service.setAutoCheckin(true)
    await settle()
    expect(timeline).toHaveLength(2)
    h.close()
  })

  test('12 点前的 ineligible 排 30 分钟后重试，12 点后的不排', async () => {
    const early = seed(
      { checkin: null },
      {
        checkin: async () => ({ outcome: 'ineligible', credit: null, streak: null, message: '不参与' }),
      },
    )
    /* NOW 是北京 12:00 整，退到 11:59 才是「12 点前」 */
    early.setNow(Date.UTC(2026, 10, 1, 3, 59, 0))
    await early.service.setAutoCheckin(true)
    await settle()
    expect(early.repository.get('a1')?.checkin?.nextTryAt).toBe(Date.UTC(2026, 10, 1, 3, 59, 0) + 30 * 60 * 1000)
    early.close()

    const late = seed(
      { checkin: null },
      {
        checkin: async () => ({ outcome: 'inactive', credit: null, streak: null, message: '活动结束' }),
      },
    )
    await late.service.setAutoCheckin(true)
    await settle()
    expect(late.repository.get('a1')?.checkin?.nextTryAt).toBe(0)
    late.close()
  })
})

describe('WorkBuddy 签到日期口径', () => {
  test('localDay 固定按 UTC+8 换日，与本机时区无关', async () => {
    const h = seed({ checkin: null })
    /* 北京 2026-11-02 07:00 = 2026-11-01 23:00Z：UTC 还是 1 号，北京已经是 2 号 */
    h.setNow(Date.UTC(2026, 10, 1, 23, 0, 0))
    await h.service.checkin('a1')
    expect(h.repository.get('a1')?.checkin?.day).toBe('2026-11-02')

    /* 北京 2026-11-02 23:00 = 同日 15:00Z：两边都还是 2 号 */
    h.setNow(Date.UTC(2026, 10, 2, 15, 0, 0))
    await h.service.checkin('a1')
    expect(h.repository.get('a1')?.checkin?.day).toBe('2026-11-02')

    /* 北京 2026-11-03 00:30 = 2 号 16:30Z：北京换日了，UTC 还没有 */
    h.setNow(Date.UTC(2026, 10, 2, 16, 30, 0))
    await h.service.checkin('a1')
    expect(h.repository.get('a1')?.checkin?.day).toBe('2026-11-03')
    h.close()
  })
})
