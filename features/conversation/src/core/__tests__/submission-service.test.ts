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
  const workspaces = {} as WorkspacesService
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
    emitRemoved: () => undefined,
    emitFailed: (p) => {
      overrides.failures?.push({ clientTurnId: p.clientTurnId, deliverAs: p.deliverAs, code: p.error.code })
    },
    acquireSession: async () => {
      if (overrides.session === undefined) throw new Error('这条用例不交接')
      return overrides.session(submits)
    },
    emitUserMessage: () => undefined,
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
