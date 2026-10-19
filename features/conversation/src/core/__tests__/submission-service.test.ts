import { describe, expect, test } from 'bun:test'
import type { EngineSession, SubmitInput } from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { systemClock } from '@poietica/foundation'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, waitFor } from '@poietica/test-kit'
import { migrations } from '../migrations'
import { SubmissionService } from '../submission-service'
import { createSubmissionsRepository, type SubmissionRow, type SubmissionsRepository } from '../submissions-repository'
import type { CollectedContext } from '../turn-context'

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
  } = {},
): {
  service: SubmissionService
  findCalls: () => number
  repo: SubmissionsRepository
} {
  const db = openDatabase(':memory:')
  for (const m of migrations) db.forModule('conversation').exec(m.sql!)
  /* 提交表有指向 thread 的外键：先把那一行补上（测试不走 thread-service） */
  db.forModule('conversation')
    .prepare(
      `INSERT INTO conversation_threads (id, workspace_id, title, title_source, posture, origin, pinned, archived, created_at, updated_at)
       VALUES ('t1', 'ws1', 't', 'auto', 'auto-edit', 'user', 0, 0, 0, 0)`,
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
  const service = new SubmissionService({
    repo,
    workspaces,
    attachments,
    clock: systemClock,
    logger: createTestLogger(),
    requireThread: () => ({ id: 't1', workspaceId: 'ws1' }),
    autoTitle: () => undefined,
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
  })
  return { service, findCalls: () => calls, repo }
}

function rowOf(clientTurnId: string, turnId: string | null): SubmissionRow {
  return {
    clientTurnId,
    threadId: 't1',
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

describe('R-20-1 迁移 v3：清掉升级前的旧账', () => {
  test('queued 与 core_restarted 的失败行删掉；被更晚的一句取代的失败行删掉；最晚的失败行留着', () => {
    const db = openDatabase(':memory:')
    const conn = db.forModule('conversation')
    for (const m of migrations.filter((m) => m.version < 3)) conn.exec(m.sql!)
    for (const id of ['t1', 't2']) {
      conn
        .prepare(
          `INSERT INTO conversation_threads (id, workspace_id, title, title_source, posture, origin, pinned, archived, created_at, updated_at)
           VALUES (?, 'ws1', 't', 'auto', 'auto-edit', 'user', 0, 0, 0, 0)`,
        )
        .run(id)
    }
    const repo = createSubmissionsRepository(conn)
    const failed = (code: string) => ({ status: 'failed' as const, error: { code, message: code } })
    const row = (id: string, threadId: string, createdAt: number, over: Partial<SubmissionRow>): SubmissionRow => ({
      ...rowOf(id, null),
      threadId,
      createdAt,
      updatedAt: createdAt,
      ...over,
    })
    repo.insert(row('q', 't1', 1, { status: 'queued', requestedAs: 'followUp' }))
    repo.insert(row('restarted', 't1', 2, failed('conversation.core_restarted')))
    repo.insert(row('old-fail', 't1', 3, failed('conversation.submit_dropped')))
    repo.insert(row('later', 't1', 4, { status: 'started', turnId: 'turn-4' }))
    repo.insert(row('last-fail', 't2', 5, failed('conversation.submit_dropped')))
    repo.insert(row('earlier', 't2', 1, { status: 'started', turnId: 'turn-1' }))

    conn.exec(migrations.find((m) => m.version === 3)!.sql!)

    expect(repo.listByThread('t1').map((r) => r.clientTurnId)).toEqual(['later'])
    expect(repo.listByThread('t2').map((r) => r.clientTurnId)).toEqual(['earlier', 'last-fail'])
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
})
