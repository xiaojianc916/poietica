import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@poietica/agent-model'
import { openDatabase } from '@poietica/storage-sqlite'
import { createJournalRepository, journalMigrations } from '../index'

const at = '2026-11-08T00:00:00.000Z'

const event = (type: AgentEvent['type'], durability: AgentEvent['durability']): AgentEvent =>
  ({ type, durability, schema: 1, at, runId: 't1' }) as AgentEvent

describe('journal', () => {
  test('committed 事件按 (threadId, agentId) 单调编号，瞬态不落库', () => {
    const db = openDatabase(':memory:')
    const moduleDb = db.forModule('journal')
    for (const migration of journalMigrations) moduleDb.exec(migration.sql)
    const service = createJournalRepository(moduleDb)
    expect(service.append('th1', 'main', [event('run.started', 'committed')])).toBe(1)
    expect(service.append('th1', 'main', [event('item.delta', 'ephemeral')])).toBe(1)
    expect(
      service.append('th1', 'main', [event('item.completed', 'committed'), event('agent.updated', 'committed')]),
    ).toBe(3)
    expect(service.append('th1', 'child', [event('run.started', 'committed')])).toBe(1)
    const stamped = service.appendAndStamp('th1', 'main', [
      event('todo.updated', 'committed'),
      event('item.delta', 'ephemeral'),
    ])
    expect(stamped.map((entry) => entry.seq)).toEqual([4, undefined])
    expect(stamped[1]?.threadId).toBe('th1')
    const read = service.read('th1', 'main', 0)
    expect(read.map((entry) => entry.type)).toEqual(['run.started', 'item.completed', 'agent.updated', 'todo.updated'])
    expect(read.map((entry) => entry.seq)).toEqual([1, 2, 3, 4])
    expect(service.read('th1', 'main', 2).map((entry) => entry.seq)).toEqual([3, 4])
    expect(service.integrity('th1', 'main')).toMatchObject({ ok: true, gaps: [] })
    moduleDb
      .prepare('DELETE FROM journal_events WHERE thread_id = ? AND agent_id = ? AND seq = ?')
      .run('th1', 'main', 2)
    expect(service.integrity('th1', 'main')).toMatchObject({ ok: false, gaps: [2] })
    expect(service.clear('th1')).toBe(4)
    expect(service.latestSeq('th1', 'main')).toBe(0)
    db.close()
  })
})

describe('journal segments', () => {
  test('满段后封段并记录校验和；篡改已封段会被隔离', () => {
    const db = openDatabase(':memory:')
    const moduleDb = db.forModule('journal')
    for (const migration of journalMigrations) moduleDb.exec(migration.sql)
    const service = createJournalRepository(moduleDb, { maxEvents: 2 })
    for (let i = 0; i < 5; i += 1) service.append('th1', 'main', [event('item.completed', 'committed')])

    let integrity = service.integrity('th1', 'main')
    expect(integrity.ok).toBe(true)
    expect(integrity.segments.map((segment) => [segment.state, segment.events])).toEqual([
      ['sealed', 2],
      ['sealed', 2],
      ['open', 1],
    ])

    moduleDb
      .prepare(
        `UPDATE journal_events SET payload = replace(payload, '"runId":"t1"', '"runId":"t2"')
         WHERE thread_id = ? AND agent_id = ? AND seq = 1`,
      )
      .run('th1', 'main')

    integrity = service.integrity('th1', 'main')
    expect(integrity.ok).toBe(false)
    expect(integrity.corruptSegments).toEqual([1])
    expect(integrity.segments[0]?.issue).toBe('校验和不符')
    expect(service.integrity('th1', 'main').segments[0]?.state).toBe('corrupt')
    db.close()
  })
})

describe('journal segment boundary', () => {
  test('恰好填满一个段时不创建空段', () => {
    const db = openDatabase(':memory:')
    const moduleDb = db.forModule('journal')
    for (const migration of journalMigrations) moduleDb.exec(migration.sql)
    const service = createJournalRepository(moduleDb, { maxEvents: 2 })
    service.append('th1', 'main', [event('run.started', 'committed'), event('run.completed', 'committed')])
    const integrity = service.integrity('th1', 'main')
    expect(integrity.ok).toBe(true)
    expect(integrity.segments).toHaveLength(1)
    expect(integrity.segments[0]?.state).toBe('sealed')
    db.close()
  })
})
