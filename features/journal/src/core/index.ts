import type { AgentEvent } from '@poietica/agent-model'
import { defineCoreModule } from '@poietica/core-kernel'
import type { ModuleDatabase } from '@poietica/storage-sqlite'
import { type JournalService, JournalServiceToken } from '../core-api'

interface EventRow {
  readonly payload: string
}

const COLUMNS = 'thread_id, agent_id, seq, payload'

/**
 * Journal 的存储（ADR-005）。committed 事件按 (threadId, agentId, seq) 追加；
 * payload 存整条 AgentEvent（含 envelope）；ompRef 单独一列供将来按 omp 条目回查。
 */
export function createJournalRepository(db: ModuleDatabase): JournalService {
  const latest = db.prepare<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM journal_events WHERE thread_id = ? AND agent_id = ?',
  )
  const insert = db.prepare(
    'INSERT INTO journal_events (thread_id, agent_id, seq, type, durability, at, payload, omp_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const read = db.prepare<EventRow>(
    `SELECT ${COLUMNS} FROM journal_events WHERE thread_id = ? AND agent_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  )
  const clear = db.prepare('DELETE FROM journal_events WHERE thread_id = ?')

  const latestSeq = (threadId: string, agentId: string): number => latest.get(threadId, agentId)?.seq ?? 0

  const appendAndStamp = (threadId: string, agentId: string, events: readonly AgentEvent[]): readonly AgentEvent[] => {
    const committed = events.filter((event) => event.durability === 'committed')
    if (committed.length === 0) return events.map((event) => ({ ...event, threadId, agentId }))
    return db.transaction(() => {
      let seq = latestSeq(threadId, agentId)
      const stamped: AgentEvent[] = []
      for (const event of events) {
        if (event.durability !== 'committed') {
          stamped.push({ ...event, threadId, agentId })
          continue
        }
        seq += 1
        const next = { ...event, threadId, agentId, seq }
        stamped.push(next)
        insert.run(
          threadId,
          agentId,
          seq,
          event.type,
          event.durability,
          event.at,
          JSON.stringify(next),
          event.ompRef === undefined ? null : JSON.stringify(event.ompRef),
        )
      }
      return stamped
    })
  }

  return {
    append(threadId, agentId, events) {
      const committed = events.filter((event) => event.durability === 'committed')
      if (committed.length === 0) return latestSeq(threadId, agentId)
      return appendAndStamp(threadId, agentId, events).reduce(
        (last, event) => (event.durability === 'committed' ? (event.seq ?? last) : last),
        latestSeq(threadId, agentId),
      )
    },

    appendAndStamp,

    read(threadId, agentId, afterSeq, limit = 500) {
      return read.all(threadId, agentId, afterSeq, limit).map((row) => JSON.parse(row.payload) as AgentEvent)
    },

    readTyped(threadId, agentId, types, limit = 5_000) {
      if (types.length === 0) return []
      const placeholders = types.map(() => '?').join(', ')
      const rows = db
        .prepare<EventRow>(
          `SELECT payload FROM journal_events
           WHERE thread_id = ? AND agent_id = ? AND type IN (${placeholders})
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(threadId, agentId, ...types, limit)
      return rows.map((row) => JSON.parse(row.payload) as AgentEvent)
    },

    latestSeq,

    integrity(threadId, agentId) {
      const seqs = db
        .prepare<{ seq: number }>(
          'SELECT seq FROM journal_events WHERE thread_id = ? AND agent_id = ? ORDER BY seq ASC',
        )
        .all(threadId, agentId)
        .map((row) => row.seq)
      const present = new Set(seqs)
      const gaps: number[] = []
      const max = seqs.at(-1) ?? 0
      for (let seq = 1; seq <= max; seq += 1) if (!present.has(seq)) gaps.push(seq)
      return { ok: gaps.length === 0, gaps }
    },

    clear(threadId) {
      return clear.run(threadId).changes
    },
  }
}

export const journalMigrations = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE journal_events (
  thread_id  TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  durability TEXT NOT NULL CHECK (durability = 'committed'),
  at         TEXT NOT NULL,
  payload    TEXT NOT NULL,
  omp_ref    TEXT,
  PRIMARY KEY (thread_id, agent_id, seq)
);
CREATE INDEX journal_events_thread ON journal_events (thread_id, agent_id, seq);`,
  },
] as const

export default defineCoreModule({
  id: 'journal',
  migrations: journalMigrations,
  setup(ctx) {
    ctx.services.provide(JournalServiceToken, createJournalRepository(ctx.db))
  },
})
