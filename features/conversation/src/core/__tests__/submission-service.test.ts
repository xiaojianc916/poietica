import { describe, expect, test } from 'bun:test'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import {
  createSubmissionsRepository,
  LEASE_WAIT_POLL_MS,
  LEASE_WAIT_TIMEOUT_MS,
  SubmissionService,
} from '@poietica/feature-runs/core'
import type {
  CollectedContext,
  SubmissionRow,
  SubmissionsRepository,
  SubmissionWriteLeasePort,
} from '@poietica/feature-runs/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { type Clock, systemClock } from '@poietica/foundation'
import type { EngineSession, SubmitInput } from '@poietica/runtime-protocol'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, fakeClock, waitFor } from '@poietica/test-kit'
import { migrations } from '../migrations'

/*
 * R-08-2：`turnId → clientTurnId` 的查询缓存。
 *
 * 判据是「同一 turn 连续 100 次 upsert，findByTurnId 被调用 ≤ 1 次」—— 直接数仓储的调用，
 * 不绕 UI，因为这个缺陷就在服务与仓储之间。
 */

function serviceOf(
  overrides: {
    readonly session?: (submits: SubmitInput[]) => EngineSession
    readonly failures?: { clientTurnId: string; deliverAs: string; code: string }[]
    readonly removed?: string[]
    readonly collectContext?: (threadId: string) => CollectedContext
    readonly lease?: SubmissionWriteLeasePort
    readonly clock?: Clock
    /** t1 的姿态（默认 auto-edit）；只读档不占写租约。 */
    readonly posture?: 'read-only' | 'auto-edit'
  } = {},
): {
  service: SubmissionService
  findCalls: () => number
  repo: SubmissionsRepository
} {
  const db = openDatabase(':memory:')
  for (const m of migrations) db.forModule('conversation').exec(m.sql)
  /* 提交表有指向 thread 的外键：先把那一行补上（测试不走 thread-service） */
  /* 提交表有指向 thread 的外键：先把那几行补上（测试不走 thread-service）。t2 在同一条工作区里，
     租约用例要靠它演「另一条对话正在写」。 */
  db.forModule('conversation')
    .prepare(
      `INSERT INTO conversation_threads (id, workspace_id, title, title_source, posture, origin, pinned, archived, created_at, updated_at)
       VALUES ('t1', 'ws1', 't', 'auto', 'auto-edit', 'user', 0, 0, 0, 0),
              ('t2', 'ws1', 't', 'auto', 'auto-edit', 'user', 0, 0, 0, 0)`,
    )
    .run()
  const inner = createSubmissionsRepository(db.forModule('conversation'))
  let calls = 0
  const repo: SubmissionsRepository = {
    ...inner,
    findByTurnId: (threadId, turnId) => {
      calls += 1
      return inner.findByTurnId(threadId, turnId)
    },
  }
  const workspaces = { requireUsable: () => undefined } as unknown as WorkspacesService
  const attachments = {
    describe: () => [],
    resolve: () => [],
    retain: () => undefined,
  } as unknown as AttachmentsService
  const submits: SubmitInput[] = []
  const service = new SubmissionService({ repo, clock: overrides.clock ?? systemClock, logger: createTestLogger() })
  service.configure({
    workspaces,
    attachments,
    requireThread: (threadId) => ({
      id: threadId,
      workspaceId: 'ws1',
      posture: threadId === 't1' ? (overrides.posture ?? 'auto-edit') : 'auto-edit',
    }),
    autoTitle: () => undefined,
    markActivity: () => undefined,
    emitChanged: () => undefined,
    emitRemoved: (p) => {
      overrides.removed?.push(p.clientTurnId)
    },
    emitFailed: (p) => {
      overrides.failures?.push({ clientTurnId: p.clientTurnId, deliverAs: p.deliverAs, code: p.error.code })
    },
    acquireSession: async () => {
      if (overrides.session === undefined) throw new Error('这条用例不交接')
      return overrides.session(submits)
    },
    emitUserMessage: () => undefined,
    ...(overrides.collectContext === undefined ? {} : { collectContext: overrides.collectContext }),
    ...(overrides.lease === undefined ? {} : { writeLease: overrides.lease }),
  })
  return { service, findCalls: () => calls, repo }
}

function rowOf(clientTurnId: string, turnId: string | null): SubmissionRow {
  return {
    clientTurnId,
    threadId: 't1',
    origin: 'user',
    text: 'hi',
    attachments: [],
    skills: [],
    requestedAs: 'turn',
    status: 'started',
    turnId,
    error: null,
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

/**
 * 一根只记账的假会话：`state()` 由测试点名，`submit` 收下这一条输入。
 *
 * 交付本身要按会话状态决定投递档（R-08-5），所以这里必须能给「忙」与「空闲」两档 ——
 * FakeEngine 一 submit 就忙，造不出「交一条 followUp 时会话还空着」这一刻。
 */
function fakeSession(submits: SubmitInput[], busy = false): EngineSession {
  let live = busy
  return {
    sessionId: 's1',
    sessionFile: 's1.jsonl',
    /* 真引擎的 submit 在返回前就把会话推成 running（OmpSession 同序）：这里照做 */
    state: () => (live ? 'running' : 'idle'),
    isBusy: () => live,
    submit: async (input: SubmitInput) => {
      submits.push(input)
      live = true
    },
  } as unknown as EngineSession
}

describe('R-08-2 turn 号缓存', () => {
  test('同一 turn 连续 100 次查询只查库一次', () => {
    const { service, findCalls, repo } = serviceOf()
    repo.insert(rowOf('c1', 'turn-1'))

    for (let i = 0; i < 100; i += 1) {
      expect(service.clientTurnIdOf('t1', 'turn-1')).toBe('c1')
    }
    expect(findCalls()).toBe(1)
  })

  test('查过没有的号也缓存（null 命中不再查库），markTurn 能把 null 覆盖掉', () => {
    const { service, findCalls, repo } = serviceOf()

    for (let i = 0; i < 100; i += 1) {
      expect(service.clientTurnIdOf('t1', 'turn-9')).toBeNull()
    }
    expect(findCalls()).toBe(1)

    /* 先查后认领是真实顺序：认领必须覆盖那一格 null，否则界面永远拿不到号 */
    repo.insert(rowOf('c9', null))
    service.markTurn('t1', 'c9', 'turn-9')
    expect(service.clientTurnIdOf('t1', 'turn-9')).toBe('c9')
    expect(findCalls()).toBe(1)
  })

  test('线程删除后缓存跟着走：再问同一个号重新查库', () => {
    const { service, findCalls, repo } = serviceOf()
    repo.insert(rowOf('c1', 'turn-1'))
    expect(service.clientTurnIdOf('t1', 'turn-1')).toBe('c1')
    expect(findCalls()).toBe(1)

    service.forget('t1')
    expect(service.clientTurnIdOf('t1', 'turn-1')).toBe('c1')
    expect(findCalls()).toBe(2)
  })
})

/*
 * R-08-5：omp 的插话 / 排队队列住进程内存里，Core 崩溃就没了。
 *
 * 从前 recoverOnStart 只收 `pending`：排过队的那条停在库里的 `queued`，界面既不画队列
 * （队列已经不存在了）也不画那条提交（`queued` 不进时间线）——用户完全不知道自己排的话没了。
 */
describe('提交的来历：定时任务投的那段话不参与起名', () => {
  test('automation 的提交不调 autoTitle；人打的那句照旧', () => {
    const titles: string[] = []
    const db = openDatabase(':memory:')
    for (const m of migrations) db.forModule('conversation').exec(m.sql)
    db.forModule('conversation')
      .prepare(
        `INSERT INTO conversation_threads (id, workspace_id, title, title_source, posture, origin, pinned, archived, created_at, updated_at)
         VALUES ('t1', 'ws1', 't', 'auto', 'auto-edit', 'user', 0, 0, 0, 0)`,
      )
      .run()
    const service = new SubmissionService({
      repo: createSubmissionsRepository(db.forModule('conversation')),
      clock: systemClock,
      logger: createTestLogger(),
    })
    service.configure({
      workspaces: { requireUsable: () => undefined } as unknown as WorkspacesService,
      attachments: { describe: () => [], resolve: () => [], retain: () => undefined } as unknown as AttachmentsService,
      requireThread: (threadId) => ({ id: threadId, workspaceId: 'ws1', posture: 'auto-edit' }),
      autoTitle: (_threadId, text) => titles.push(text),
      markActivity: () => undefined,
      emitChanged: () => undefined,
      emitRemoved: () => undefined,
      emitFailed: () => undefined,
      acquireSession: async () => {
        throw new Error('这条用例不交接')
      },
      emitUserMessage: () => undefined,
    })

    service.submit({
      threadId: 't1',
      clientTurnId: 'a1',
      text: '【定时任务】自检 · 手动运行',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
      origin: 'automation',
    })
    expect(titles).toEqual([])

    service.submit({
      threadId: 't1',
      clientTurnId: 'u1',
      text: '你好',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    expect(titles).toEqual(['你好'])
    db.close()
  })
})

describe('R-08-5 重启后排队的话不再静默丢失', () => {
  test('recoverOnStart 把 queued 也收成 failed(core_restarted) 并广播失败事件', () => {
    const failures: { clientTurnId: string; deliverAs: string; code: string }[] = []
    const { service, repo } = serviceOf({ failures })
    repo.insert({ ...rowOf('c1', null), status: 'queued', requestedAs: 'followUp', text: '排队的一句' })
    repo.insert({ ...rowOf('c2', null), status: 'pending', requestedAs: 'turn', text: '没交出去的一句' })
    repo.insert({
      ...rowOf('c3', 'turn-9'),
      status: 'started',
      requestedAs: 'turn',
      text: '在跑的一句',
      updatedAt: Date.now(),
    })

    service.recoverOnStart()

    expect(repo.get('c1')?.status).toBe('failed')
    expect(repo.get('c1')?.error?.code).toBe('conversation.core_restarted')
    /* 落库的是那句中文，不是码 —— 任务运行记录直接拿它拼「没能开始运行：…」 */
    expect(repo.get('c1')?.error?.message).toBe('Core 已重启，这条消息没有发出')
    expect(repo.get('c2')?.status).toBe('failed')
    /* 真实轮次照旧：它已经开出来了，收掉它等于把界面上那一轮也划掉 */
    expect(repo.get('c3')?.status).toBe('started')
    expect(failures).toEqual([
      { clientTurnId: 'c1', deliverAs: 'followUp', code: 'conversation.core_restarted' },
      { clientTurnId: 'c2', deliverAs: 'turn', code: 'conversation.core_restarted' },
    ])
  })

  test('重试一条失败的 followUp：会话空闲时按新一轮交出去（不再记成排队）', async () => {
    const submits: SubmitInput[] = []
    const { service, repo } = serviceOf({ session: () => fakeSession(submits) })
    repo.insert({
      ...rowOf('c1', null),
      status: 'failed',
      requestedAs: 'followUp',
      error: { code: 'x', message: 'x' },
    })

    service.retry('c1')
    /* 交接是后台的一趟（车道 → 取会话 → 提交）：等它跑到终点 */
    await waitFor(() => submits.length > 0)

    expect(submits.map((input) => input.deliverAs)).toEqual(['turn'])
    /*
     * 交给 omp 的就是一条新一轮：提交停在 pending 等真实 turn 来认领（认领时才进 started）。
     * 记成 queued 就反了 —— 那是一条已经开跑的轮，标成排队界面就再也画不出它。
     */
    expect(repo.get('c1')?.status).toBe('pending')
  })

  test('重试一条失败的 followUp：会话还在忙时仍旧排队', async () => {
    const submits: SubmitInput[] = []
    const { service, repo } = serviceOf({ session: () => fakeSession(submits, true) })
    repo.insert({
      ...rowOf('c1', null),
      status: 'failed',
      requestedAs: 'followUp',
      error: { code: 'x', message: 'x' },
    })

    service.retry('c1')
    await waitFor(() => submits.length > 0)

    expect(submits.map((input) => input.deliverAs)).toEqual(['followUp'])
    expect(repo.get('c1')?.status).toBe('queued')
  })

  test('重试一条失败的插话：会话还在忙时仍旧插话', async () => {
    const submits: SubmitInput[] = []
    const { service, repo } = serviceOf({ session: () => fakeSession(submits, true) })
    repo.insert({
      ...rowOf('c1', null),
      status: 'failed',
      requestedAs: 'steer',
      error: { code: 'x', message: 'x' },
    })

    service.retry('c1')
    await waitFor(() => submits.length > 0)

    expect(submits.map((input) => input.deliverAs)).toEqual(['steer'])
    expect(repo.get('c1')?.status).toBe('queued')
  })
})

/*
 * R-20-1：排队项要有结局。之前 `queued` 永远停着，下次 Core 启动全部被改成 failed / core_restarted，
 * 旧对话凭空冒出「提交未完成；请先核对会话。」与「取回文字」。
 */
describe('R-20-1 排队项收口', () => {
  async function queuedOne(
    over: { removed?: string[]; failures?: { clientTurnId: string; deliverAs: string; code: string }[] } = {},
  ) {
    const submits: SubmitInput[] = []
    const ctx = serviceOf({ ...over, session: () => fakeSession(submits, true) })
    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '第二句',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await waitFor(() => ctx.repo.get('c1')?.status === 'queued')
    return { ...ctx, submits }
  }

  test('submit 返回时会话事件还没到：不把已送达的一句误判成 dropped', async () => {
    const submits: SubmitInput[] = []
    const { service, repo } = serviceOf({
      session: () => ({
        ...fakeSession(submits, false),
        /* ARP 事件可能晚于 submit 响应到达：这一刻 Core 看到的 state 仍是 idle */
        submit: async (input: SubmitInput) => {
          submits.push(input)
        },
      }),
    })
    service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: 'hi',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await waitFor(() => submits.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(repo.get('c1')).toMatchObject({ status: 'pending', error: null })
  })

  test('忙时发出的一句降级成排队：交给引擎时带上自己的号', async () => {
    const { submits } = await queuedOne()
    expect(submits.map((input) => [input.deliverAs, input.ref])).toEqual([['followUp', 'c1']])
  })

  test('送达 → 删行并推 removed（之后 recoverOnStart 不会再把它改成 failed）', async () => {
    const removed: string[] = []
    const failures: { clientTurnId: string; deliverAs: string; code: string }[] = []
    const { service, repo } = await queuedOne({ removed, failures })

    service.settleQueued('t1', 'c1', 'delivered')
    service.recoverOnStart()

    expect(repo.get('c1')).toBeNull()
    expect(removed).toEqual(['c1'])
    expect(failures).toEqual([])
  })

  test('撤回 → 删行并推 removed', async () => {
    const removed: string[] = []
    const { service, repo } = await queuedOne({ removed })
    service.settleQueued('t1', 'c1', 'withdrawn')
    expect(repo.get('c1')).toBeNull()
    expect(removed).toEqual(['c1'])
  })

  test('被 omp 丢弃 → failed(submit_dropped)，并广播失败事件', async () => {
    const failures: { clientTurnId: string; deliverAs: string; code: string }[] = []
    const { service, repo } = await queuedOne({ failures })
    service.settleQueued('t1', 'c1', 'dropped')
    expect(repo.get('c1')?.status).toBe('failed')
    expect(repo.get('c1')?.error?.code).toBe('conversation.submit_dropped')
    expect(failures).toEqual([{ clientTurnId: 'c1', deliverAs: 'turn', code: 'conversation.submit_dropped' }])
  })

  test('幂等：别的线程、已开轮、已失败、不存在的号一律不动', async () => {
    const removed: string[] = []
    const { service, repo } = await queuedOne({ removed })
    repo.insert({ ...rowOf('c2', 'turn-2'), status: 'started' })
    repo.insert({ ...rowOf('c3', null), status: 'failed', error: { code: 'x', message: 'x' } })

    service.settleQueued('t2', 'c1', 'delivered')
    service.settleQueued('t1', 'c2', 'delivered')
    service.settleQueued('t1', 'c3', 'withdrawn')
    service.settleQueued('t1', 'nope', 'delivered')

    expect(repo.get('c1')?.status).toBe('queued')
    expect(repo.get('c2')?.status).toBe('started')
    expect(repo.get('c3')?.status).toBe('failed')
    expect(removed).toEqual([])
  })

  test('结局先于「记成 queued」到达：行不会被复活成 queued', async () => {
    const removed: string[] = []
    let service!: SubmissionService
    const ctx = serviceOf({
      removed,
      session: (submits) =>
        ({
          sessionId: 's1',
          sessionFile: 's1.jsonl',
          state: () => 'running',
          isBusy: () => true,
          submit: async (input: SubmitInput) => {
            submits.push(input)
            /* 引擎在 submit 返回前就报了送达（omp 的 queue_update 抢在前面） */
            service.settleQueued('t1', input.ref!, 'delivered')
          },
        }) as unknown as EngineSession,
    })
    service = ctx.service
    service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '抢跑',
      attachmentIds: [],
      skills: [],
      deliverAs: 'followUp',
    })
    await waitFor(() => removed.length > 0)
    await Bun.sleep(5)

    expect(ctx.repo.get('c1')).toBeNull()
  })

  test('新的一句进来：同线程更早的失败行到此为止（删行并推 removed）', () => {
    const removed: string[] = []
    const { service, repo } = serviceOf({ removed })
    repo.insert({ ...rowOf('c0', null), status: 'failed', error: { code: 'x', message: 'x' } })

    service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '接着说',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })

    expect(repo.get('c0')).toBeNull()
    expect(repo.get('c1')?.status).toBe('pending')
    expect(removed).toEqual(['c0'])
  })

  test('丢弃一条失败行也推 removed（别的窗口里那一行要跟着消失）', () => {
    const removed: string[] = []
    const { service, repo } = serviceOf({ removed })
    repo.insert({ ...rowOf('c0', null), status: 'failed', error: { code: 'x', message: 'x' } })
    service.discard('c0')
    expect(removed).toEqual(['c0'])
  })
})

/*
 * 排队项的上下文回执（第一阶段 R1）：插话 / 排队交给 omp 之后被丢弃，提供方要把「已交出」退回去，
 * 下一句再交一次；submit 还没返回结局就先到了，按结局算，不先记已交再撤。
 */
describe('排队项的上下文回执', () => {
  function receipts(): { readonly log: string[]; readonly collect: (threadId: string) => CollectedContext } {
    const log: string[] = []
    return {
      log,
      collect: () => ({
        blocks: [{ source: 'intelligent-ui', text: '「配色」：{"choice":"B"}' }],
        delivered: () => log.push('delivered'),
        undelivered: () => log.push('undelivered'),
      }),
    }
  }

  async function queued(collect: (threadId: string) => CollectedContext) {
    const ctx = serviceOf({ collectContext: collect, session: (submits) => fakeSession(submits, true) })
    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '再来一版',
      attachmentIds: [],
      skills: [],
      deliverAs: 'followUp',
    })
    await waitFor(() => ctx.repo.get('c1') !== null && ctx.repo.get('c1')?.status !== 'pending')
    return ctx
  }

  test('U1 送达：只记一次已交', async () => {
    const r = receipts()
    const { service } = await queued(r.collect)
    service.settleQueued('t1', 'c1', 'delivered')
    expect(r.log).toEqual(['delivered'])
  })

  test('U2 被丢弃 / 撤回：已交退回成未交；重复的结局不再动', async () => {
    const r = receipts()
    const { service } = await queued(r.collect)
    service.settleQueued('t1', 'c1', 'dropped')
    service.settleQueued('t1', 'c1', 'dropped')
    expect(r.log).toEqual(['delivered', 'undelivered'])
  })

  test('U3 结局抢在 submit 返回之前：丢弃 → 两头都不记；送达 → 只记已交', async () => {
    for (const outcome of ['dropped', 'delivered'] as const) {
      const r = receipts()
      let service!: SubmissionService
      const ctx = serviceOf({
        collectContext: r.collect,
        session: (submits) =>
          ({
            sessionId: 's1',
            sessionFile: 's1.jsonl',
            state: () => 'running',
            isBusy: () => true,
            submit: async (input: SubmitInput) => {
              submits.push(input)
              /* omp 的 queue_update 抢在 submit 返回之前 */
              service.settleQueued('t1', input.ref!, outcome)
            },
          }) as unknown as EngineSession,
      })
      service = ctx.service
      service.submit({
        threadId: 't1',
        clientTurnId: 'c1',
        text: '抢跑',
        attachmentIds: [],
        skills: [],
        deliverAs: 'followUp',
      })
      await waitFor(() => ctx.repo.get('c1')?.status !== 'pending')
      expect(r.log).toEqual(outcome === 'delivered' ? ['delivered'] : [])
    }
  })
})

/*
 * R1 残留清理：排队上下文不能活过「这一条再也不会送达」的收口。
 *
 * 这些路径原先只改库 / 删行，queuedContexts 仍按 clientTurnId 挂着：Core 长期运行会只增不减，
 * 已经记过「已交」的那一笔也再没人撤销。下面逐条钉住「条目被摘掉、回执不重复」。
 */
describe('R1 排队上下文在失败路径收口', () => {
  interface DebugQueuedEntry {
    readonly threadId: string
    readonly context: CollectedContext
    readonly submitted: boolean
    readonly settled: null
  }

  /*
   * settleUnstarted / cancelUnhanded / supersedeFailed / discard 的正常入口都先把行改成 failed，
   * 旧代码在这里不可能留下条目 —— 只有历史泄漏（或别的收口路径漏删）才会出现。为了把这几条出口
   * 单独钉住，测试直接种一条「已交、等结局」的残留；行为与真实的 QueuedContext 同形。
   */
  function seedQueuedContext(
    service: SubmissionService,
    clientTurnId: string,
    threadId: string,
    log: string[],
    submitted = true,
  ): void {
    const contexts = (service as unknown as { queuedContexts: Map<string, DebugQueuedEntry> }).queuedContexts
    contexts.set(clientTurnId, {
      threadId,
      context: {
        blocks: [{ source: 'intelligent-ui', text: '「配色」：{"choice":"B"}' }],
        delivered: () => log.push('delivered'),
        undelivered: () => log.push('undelivered'),
      },
      submitted,
      settled: null,
    })
  }

  /** 可切换忙 / 闲的会话：第一句排队，重试时可换成直接开轮 */
  function switchableSession(submits: SubmitInput[]): { readonly session: EngineSession; idle(): void } {
    let live: 'idle' | 'running' = 'running'
    const session = {
      sessionId: 's1',
      sessionFile: 's1.jsonl',
      state: () => live,
      isBusy: () => live !== 'idle',
      submit: async (input: SubmitInput) => {
        submits.push(input)
        live = 'running'
      },
    } as unknown as EngineSession
    return {
      session,
      idle: () => {
        live = 'idle'
      },
    }
  }

  /** 交接车道是否还在跑：cancelUnhanded 只认「已经不在 handed 里」的 pending，必须等这趟收尾 */
  function laneActive(service: SubmissionService, threadId: string): boolean {
    return (service as unknown as { lanes: Map<string, unknown> }).lanes.has(threadId)
  }

  /** 走一遍真实交接：提交停在 queued，上下文已记「已交」 */
  async function queuedWithContext() {
    const log: string[] = []
    const submits: SubmitInput[] = []
    const control = switchableSession(submits)
    const ctx = serviceOf({
      session: () => control.session,
      collectContext: () => ({
        blocks: [{ source: 'intelligent-ui', text: '「配色」：{"choice":"B"}' }],
        delivered: () => log.push('delivered'),
        undelivered: () => log.push('undelivered'),
      }),
    })
    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '再来一版',
      attachmentIds: [],
      skills: [],
      deliverAs: 'followUp',
    })
    await waitFor(() => ctx.repo.get('c1')?.status === 'queued' && !laneActive(ctx.service, 't1'))
    return { ...ctx, submits, control, log }
  }

  /*
   * 交出一轮、引擎收下但还没产出 turn：行停在 pending，pendingTurn 已登记，handed 已收尾。
   * settleUnstarted / cancelUnhanded 的真实前提就是这样。
   */
  async function pendingTurn() {
    const submits: SubmitInput[] = []
    let live: 'idle' | 'running' = 'idle'
    const ctx = serviceOf({
      session: () =>
        ({
          sessionId: 's1',
          sessionFile: 's1.jsonl',
          state: () => live,
          isBusy: () => live !== 'idle',
          submit: async (input: SubmitInput) => {
            submits.push(input)
            live = 'running'
          },
        }) as unknown as EngineSession,
    })
    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '引擎收下但没开轮',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await waitFor(() => ctx.repo.get('c1')?.status === 'pending' && !laneActive(ctx.service, 't1'))
    return { ...ctx, submits }
  }

  test('recoverOnStart：queued 收成 failed 后不再残留，已交出的只回退一次', async () => {
    const { service, repo, log } = await queuedWithContext()
    expect(service.has('t1')).toBe(true)
    expect(log).toEqual(['delivered'])

    service.recoverOnStart()
    service.recoverOnStart()

    expect(repo.get('c1')?.status).toBe('failed')
    expect(service.has('t1')).toBe(false)
    expect(log).toEqual(['delivered', 'undelivered'])
  })

  test('discard：删掉 failed 行时把还挂着的上下文一并清掉', () => {
    const log: string[] = []
    const { service, repo } = serviceOf()
    repo.insert({ ...rowOf('c0', null), status: 'failed', error: { code: 'x', message: 'x' } })
    seedQueuedContext(service, 'c0', 't1', log)
    expect(service.has('t1')).toBe(true)

    service.discard('c0')

    expect(repo.get('c0')).toBeNull()
    expect(service.has('t1')).toBe(false)
    expect(log).toEqual(['undelivered'])
  })

  test('settleUnstarted：pending 收成 failed 后不再残留，重复收口不再回调', async () => {
    const log: string[] = []
    const { service, repo } = await pendingTurn()
    seedQueuedContext(service, 'c1', 't1', log)
    expect(service.has('t1')).toBe(true)

    service.settleUnstarted('t1', { code: 'conversation.submit_dropped', message: '引擎没开轮' })
    service.settleUnstarted('t1', { code: 'conversation.submit_dropped', message: '引擎没开轮' })

    expect(repo.get('c1')?.status).toBe('failed')
    expect(service.has('t1')).toBe(false)
    expect(log).toEqual(['undelivered'])
  })

  test('cancelUnhanded：未交给 omp 的 pending 收成 failed 后不再残留，重复取消不再回调', async () => {
    const log: string[] = []
    const { service, repo } = await pendingTurn()
    seedQueuedContext(service, 'c1', 't1', log)
    expect(service.has('t1')).toBe(true)

    service.cancelUnhanded('t1')
    service.cancelUnhanded('t1')

    expect(repo.get('c1')?.status).toBe('failed')
    expect(repo.get('c1')?.error?.code).toBe('conversation.submit_cancelled')
    /* 码不是给人看的话：落库的 remarks 必须是那句中文（任务运行记录直接拿它拼）。 */
    expect(repo.get('c1')?.error?.message).toBe('这句话已停止')
    expect(service.has('t1')).toBe(false)
    expect(log).toEqual(['undelivered'])
  })

  test('markFailed（经 settleQueued 丢弃）：条目被摘掉，重复的结局不再回调', async () => {
    const { service, repo, log } = await queuedWithContext()

    service.settleQueued('t1', 'c1', 'dropped')
    service.settleQueued('t1', 'c1', 'dropped')

    expect(repo.get('c1')?.status).toBe('failed')
    expect(service.has('t1')).toBe(false)
    expect(log).toEqual(['delivered', 'undelivered'])
  })

  test('supersedeFailed：新的一句删掉更早 failed 行时，连带清掉它还挂着的上下文', async () => {
    const log: string[] = []
    const { service, repo } = serviceOf()
    repo.insert({ ...rowOf('c0', null), status: 'failed', error: { code: 'x', message: 'x' } })
    seedQueuedContext(service, 'c0', 't1', log)

    service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '接着说',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    /* 新的一句交接失败也不影响上一步：这里等车道收尾，好让 has 只看冻结后的状态 */
    await waitFor(() => repo.get('c1')?.status === 'failed' && !laneActive(service, 't1'))

    expect(repo.get('c0')).toBeNull()
    expect(service.has('t1')).toBe(false)
    expect(log).toEqual(['undelivered'])
  })

  test('submit 尚未返回就重启：只清未交付的条目，不补 undelivered / delivered', async () => {
    const log: string[] = []
    let started!: () => void
    const startedP = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submits: SubmitInput[] = []
    const ctx = serviceOf({
      session: () =>
        ({
          sessionId: 's1',
          sessionFile: 's1.jsonl',
          state: () => 'running',
          isBusy: () => true,
          submit: async (input: SubmitInput) => {
            submits.push(input)
            started()
            await gate
          },
        }) as unknown as EngineSession,
      collectContext: () => ({
        blocks: [{ source: 'intelligent-ui', text: '「配色」：{"choice":"B"}' }],
        delivered: () => log.push('delivered'),
        undelivered: () => log.push('undelivered'),
      }),
    })
    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '交给引擎途中重启',
      attachmentIds: [],
      skills: [],
      deliverAs: 'followUp',
    })
    await startedP
    expect(ctx.service.has('t1')).toBe(true)

    ctx.service.recoverOnStart()
    expect(ctx.repo.get('c1')?.status).toBe('failed')
    release()
    await waitFor(() => !laneActive(ctx.service, 't1'))

    expect(ctx.service.has('t1')).toBe(false)
    expect(log).toEqual([])
    expect(submits).toHaveLength(1)
  })

  /*
   * §14.4 只限**并发写**，不判死这一句。真实故障（2026-11-16）：完全访问的旧对话还在跑时，
   * 三种档位（只读 / 请求批准 / 帮我批准）各新开一条对话发一句话 —— 三句全部当场收成
   * `workspaces.write_busy`，既没交给引擎（屏幕上没有回复、没有时间线），又只剩一条
   * 「提交未完成；请先核对会话。」的横幅。租约冲突必须是**排队**，不是终点。
   */
  function leaseFixture() {
    let holder: string | null = null
    let nextId = 0
    const released: string[] = []
    const lease = {
      acquire(input: { threadId: string }) {
        if (holder !== null && holder !== input.threadId)
          return { granted: false as const, holder: { threadId: holder } }
        holder = input.threadId
        return { granted: true as const, lease: { id: `lease-${++nextId}` } }
      },
      release(leaseId: string) {
        released.push(leaseId)
        holder = null
      },
    }
    return { lease, released, holder: () => holder }
  }

  /**
   * 这条工作区此刻由 t2 的写轮持有（真路径：t2 自己提交、拿到租约、轮次还没收口）。
   * `submits` 由 session 工厂交回来的那一个数组接上 —— 服务内部的记账表才是唯一事实。
   */
  async function busyWorkspace(clock?: Clock) {
    const fixture = leaseFixture()
    const failures: { clientTurnId: string; deliverAs: string; code: string }[] = []
    let submits: SubmitInput[] = []
    const ctx = serviceOf({
      lease: fixture.lease,
      failures,
      session: (all) => {
        submits = all
        return fakeSession(all)
      },
      ...(clock === undefined ? {} : { clock }),
    })
    ctx.service.submit({
      threadId: 't2',
      clientTurnId: 'c0',
      text: '另一条对话正在写',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await waitFor(() => submits.length === 1)
    return { ...ctx, fixture, failures, submits }
  }

  test('工作区写租约：别人的写轮占着时排队等，收口释放后这一句自己交出去', async () => {
    const ctx = await busyWorkspace()

    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '排在别人的写轮后面',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    /* 还没腾出来：既没失败、也没交给引擎 —— 从前就是在这里被当场收成 write_busy */
    await Bun.sleep(20)
    expect(ctx.failures).toEqual([])
    expect(ctx.submits.map((entry) => entry.text)).toEqual(['另一条对话正在写'])
    expect(ctx.repo.get('c1')?.status).toBe('pending')

    /* t2 那一轮收口：租约释放，等着的这一句自己往下走 */
    ctx.service.releaseWriteLease('t2')
    await waitFor(() => ctx.submits.length === 2)

    expect(ctx.submits[1]?.text).toBe('排在别人的写轮后面')
    expect(ctx.failures).toEqual([])
    expect(ctx.fixture.holder()).toBe('t1')
    ctx.service.releaseWriteLease('t1')
    expect(ctx.fixture.released).toEqual(['lease-1', 'lease-2'])
  })

  /*
   * 真机故障（2026-11-19）：只读档的定时任务占住写租约，同工作区里所有真正要写的对话排在它后面；
   * 而它自己不写工作区 —— 抢一个用不上的租约，把别人全堵死。只读档直接放行，不碰租约。
   */
  test('只读档不占写租约：别人的写轮占着也照常交出去', async () => {
    const fixture = leaseFixture()
    const submits: SubmitInput[] = []
    const ctx = serviceOf({
      lease: fixture.lease,
      session: () => fakeSession(submits),
      posture: 'read-only',
    })
    /* t2 先拿走租约 */
    ctx.service.submit({
      threadId: 't2',
      clientTurnId: 'c0',
      text: '另一条对话正在写',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await waitFor(() => submits.length === 1)
    expect(fixture.holder()).toBe('t2')

    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '只读的一句',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await waitFor(() => submits.length === 2)

    expect(submits[1]?.text).toBe('只读的一句')
    /* 租约还是 t2 的：只读那一句既没抢、也没放别人的 */
    expect(fixture.holder()).toBe('t2')
    expect(fixture.released).toEqual([])
  })

  test('等租约的期间被停止：这一句不再交出去（也不去抢租约）', async () => {
    const ctx = await busyWorkspace()

    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '排队时被停止',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    await Bun.sleep(20)
    ctx.service.cancelUnhanded('t1')
    ctx.service.releaseWriteLease('t2')
    await Bun.sleep(30)

    expect(ctx.submits.map((entry) => entry.text)).toEqual(['另一条对话正在写'])
    expect(ctx.fixture.holder()).toBeNull()
    expect(ctx.repo.get('c1')?.error?.code).toBe('conversation.submit_cancelled')
  })

  test('等租约超时：收成可操作的 workspaces.write_busy，不再是无声的失败', async () => {
    const clock = fakeClock()
    const ctx = await busyWorkspace(clock)

    ctx.service.submit({
      threadId: 't1',
      clientTurnId: 'c1',
      text: '等太久',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    /* 先让交接车道跑到「在等租约」（那时才登记兜底节拍），再把假时钟推过超时 */
    await Bun.sleep(20)
    await clock.advanceAsync(LEASE_WAIT_TIMEOUT_MS + LEASE_WAIT_POLL_MS * 2)
    await waitFor(() => ctx.failures.length === 1)

    expect(ctx.failures[0]).toMatchObject({ clientTurnId: 'c1', code: 'workspaces.write_busy' })
    expect(ctx.submits.map((entry) => entry.text)).toEqual(['另一条对话正在写'])
  })
})
