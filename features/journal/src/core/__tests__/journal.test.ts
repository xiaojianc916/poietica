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
    expect(service.integrity('th1', 'main')).toEqual({ ok: true, gaps: [] })
    moduleDb
      .prepare('DELETE FROM journal_events WHERE thread_id = ? AND agent_id = ? AND seq = ?')
      .run('th1', 'main', 2)
    expect(service.integrity('th1', 'main')).toEqual({ ok: false, gaps: [2] })
    expect(service.clear('th1')).toBe(4)
    expect(service.latestSeq('th1', 'main')).toBe(0)
    db.close()
  })
})
