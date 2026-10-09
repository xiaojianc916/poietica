import { describe, expect, test } from 'bun:test'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { systemClock } from '@poietica/foundation'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger } from '@poietica/test-kit'
import { migrations } from '../migrations'
import { SubmissionService } from '../submission-service'
import { createSubmissionsRepository, type SubmissionRow, type SubmissionsRepository } from '../submissions-repository'

/*
 * R-08-2：`turnId → clientTurnId` 的查询缓存。
 *
 * 判据是「同一 turn 连续 100 次 upsert，findByTurnId 被调用 ≤ 1 次」—— 直接数仓储的调用，
 * 不绕 UI，因为这个缺陷就在服务与仓储之间。
 */

function serviceOf(): { service: SubmissionService; findCalls: () => number; repo: SubmissionsRepository } {
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
    retain: () => undefined,
  } as unknown as AttachmentsService
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
    emitFailed: () => undefined,
    acquireSession: async () => {
      throw new Error('这条用例不交接')
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
