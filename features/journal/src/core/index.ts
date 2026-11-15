import { createHash } from 'node:crypto'
import type { AgentEvent } from '@poietica/agent-model'
import { defineCoreModule } from '@poietica/core-kernel'
import type { ModuleDatabase } from '@poietica/storage-sqlite'
import { type JournalIntegrity, type JournalSegment, type JournalService, JournalServiceToken } from '../core-api'

interface EventRow {
  readonly payload: string
}

interface QueryRow {
  readonly thread_id: string
  readonly payload: string
}

interface SegmentRow {
  readonly segment_id: number
  readonly start_seq: number
  readonly end_seq: number | null
  readonly event_count: number
  readonly bytes: number
  readonly checksum: string | null
  readonly state: 'open' | 'sealed' | 'corrupt'
}

interface EventStats {
  readonly count: number
  readonly start: number | null
  readonly end: number | null
  readonly bytes: number
}

const COLUMNS = 'thread_id, agent_id, seq, payload'
const DEFAULT_MAX_EVENTS = 1_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export interface CreateJournalOptions {
  /** 一个分段最多多少条事件；到达后封段。缺省 1000。 */
  readonly maxEvents?: number
  /** 一个分段最多多少字节；到达后封段。缺省 2 MiB。 */
  readonly maxBytes?: number
}

/**
 * Journal 的存储（ADR-005）。committed 事件按 (threadId, agentId, seq) 追加；
 * payload 存整条 AgentEvent（含 envelope）；ompRef 单独一列供将来按 omp 条目回查。
 *
 * 事件同时归入分段：段满后封段并记录校验和，启动对账可逐段校验。分段只是完整性单位，
 * 读取仍按 seq 走同一张表，不改变对外语义。
 */
export function createJournalRepository(db: ModuleDatabase, options: CreateJournalOptions = {}): JournalService {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const latest = db.prepare<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM journal_events WHERE thread_id = ? AND agent_id = ?',
  )
  const insert = db.prepare(
    `INSERT INTO journal_events (thread_id, agent_id, seq, type, durability, at, payload, omp_ref, segment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const read = db.prepare<EventRow>(
    `SELECT ${COLUMNS} FROM journal_events WHERE thread_id = ? AND agent_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  )
  const clearEvents = db.prepare('DELETE FROM journal_events WHERE thread_id = ?')
  const clearSegments = db.prepare('DELETE FROM journal_segments WHERE thread_id = ?')
  const openSegment = db.prepare<SegmentRow>(
    `SELECT segment_id, start_seq, end_seq, event_count, bytes, checksum, state
     FROM journal_segments WHERE thread_id = ? AND agent_id = ? AND state = 'open'
     ORDER BY segment_id DESC LIMIT 1`,
  )
  const nextSegmentId = db.prepare<{ id: number | null }>(
    'SELECT MAX(segment_id) AS id FROM journal_segments WHERE thread_id = ? AND agent_id = ?',
  )
  const createSegment = db.prepare(
    `INSERT INTO journal_segments
       (thread_id, agent_id, segment_id, start_seq, end_seq, event_count, bytes, checksum, state, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, NULL, 'open', ?)`,
  )
  const growSegment = db.prepare(
    `UPDATE journal_segments SET end_seq = ?, event_count = event_count + 1, bytes = bytes + ?
     WHERE thread_id = ? AND agent_id = ? AND segment_id = ?`,
  )
  const sealSegment = db.prepare(
    `UPDATE journal_segments SET state = 'sealed', checksum = ?, sealed_at = ?
     WHERE thread_id = ? AND agent_id = ? AND segment_id = ?`,
  )
  const corruptSegment = db.prepare(
    `UPDATE journal_segments SET state = 'corrupt' WHERE thread_id = ? AND agent_id = ? AND segment_id = ?`,
  )
  const segments = db.prepare<SegmentRow>(
    `SELECT segment_id, start_seq, end_seq, event_count, bytes, checksum, state
     FROM journal_segments WHERE thread_id = ? AND agent_id = ? ORDER BY segment_id ASC`,
  )
  const segmentStats = db.prepare<EventStats>(
    `SELECT COUNT(*) AS count, MIN(seq) AS start, MAX(seq) AS end,
            COALESCE(SUM(LENGTH(payload)), 0) AS bytes
     FROM journal_events WHERE thread_id = ? AND agent_id = ? AND segment_id = ?`,
  )
  const segmentPayloads = db.prepare<{ seq: number; payload: string }>(
    `SELECT seq, payload FROM journal_events
     WHERE thread_id = ? AND agent_id = ? AND segment_id = ? ORDER BY seq ASC`,
  )

  const latestSeq = (threadId: string, agentId: string): number => latest.get(threadId, agentId)?.seq ?? 0

  const checksumOf = (threadId: string, agentId: string, segmentId: number): string => {
    const hash = createHash('sha256')
    for (const row of segmentPayloads.all(threadId, agentId, segmentId)) {
      hash.update(`${row.seq}\0${row.payload}\n`)
    }
    return hash.digest('hex')
  }

  const appendAndStamp = (threadId: string, agentId: string, events: readonly AgentEvent[]): readonly AgentEvent[] => {
    const committed = events.filter((event) => event.durability === 'committed')
    if (committed.length === 0) return events.map((event) => ({ ...event, threadId, agentId }))
    return db.transaction(() => {
      let seq = latestSeq(threadId, agentId)
      let segment = openSegment.get(threadId, agentId) ?? undefined
      let segmentCount = segment?.event_count ?? 0
      let segmentBytes = segment?.bytes ?? 0
      const stamped: AgentEvent[] = []
      for (const event of events) {
        if (event.durability !== 'committed') {
          stamped.push({ ...event, threadId, agentId })
          continue
        }
        seq += 1
        const next = { ...event, threadId, agentId, seq }
        segment ??= openSegmentFor(threadId, agentId, seq)
        const bytes = writeCommitted(threadId, agentId, next, segment.segment_id)
        stamped.push(next)
        segmentCount += 1
        segmentBytes += bytes
        if (segmentCount >= maxEvents || segmentBytes >= maxBytes) {
          sealSegment.run(
            checksumOf(threadId, agentId, segment.segment_id),
            Date.now(),
            threadId,
            agentId,
            segment.segment_id,
          )
          segment = undefined
          segmentCount = 0
          segmentBytes = 0
        }
      }
      return stamped
    })
  }

  function writeCommitted(
    threadId: string,
    agentId: string,
    event: AgentEvent & { readonly seq: number },
    segmentId: number,
  ): number {
    const payload = JSON.stringify(event)
    insert.run(
      threadId,
      agentId,
      event.seq,
      event.type,
      event.durability,
      event.at,
      payload,
      event.ompRef === undefined ? null : JSON.stringify(event.ompRef),
      segmentId,
    )
    growSegment.run(event.seq, Buffer.byteLength(payload), threadId, agentId, segmentId)
    return Buffer.byteLength(payload)
  }

  function openSegmentFor(threadId: string, agentId: string, startSeq: number): SegmentRow {
    const id = (nextSegmentId.get(threadId, agentId)?.id ?? 0) + 1
    createSegment.run(threadId, agentId, id, startSeq, startSeq, Date.now())
    return {
      segment_id: id,
      start_seq: startSeq,
      end_seq: startSeq,
      event_count: 0,
      bytes: 0,
      checksum: null,
      state: 'open',
    }
  }

  const segmentIssue = (
    threadId: string,
    agentId: string,
    segment: SegmentRow,
    stats: EventStats,
  ): string | undefined => {
    if (stats.count === 0) return '分段没有事件'
    if (stats.start !== segment.start_seq) return '起始序号不符'
    if (segment.end_seq !== null && stats.end !== segment.end_seq) return '结束序号不符'
    if (stats.count !== segment.event_count) return '事件数不符'
    if (stats.bytes !== segment.bytes) return '字节数不符'
    if (segment.state === 'sealed' && checksumOf(threadId, agentId, segment.segment_id) !== segment.checksum) {
      return '校验和不符'
    }
    return undefined
  }

  const inspectSegment = (threadId: string, agentId: string, segment: SegmentRow): JournalSegment => {
    const stats = segmentStats.get(threadId, agentId, segment.segment_id) ?? {
      count: 0,
      start: null,
      end: null,
      bytes: 0,
    }
    const issue = segmentIssue(threadId, agentId, segment, stats)
    if (issue !== undefined && segment.state !== 'corrupt') {
      corruptSegment.run(threadId, agentId, segment.segment_id)
    }
    return {
      id: segment.segment_id,
      state: issue === undefined ? segment.state : 'corrupt',
      startSeq: segment.start_seq,
      endSeq: segment.end_seq,
      events: segment.event_count,
      bytes: segment.bytes,
      ...(issue === undefined ? {} : { issue }),
    }
  }

  const integrity = (threadId: string, agentId: string): JournalIntegrity => {
    const seqs = db
      .prepare<{ seq: number }>('SELECT seq FROM journal_events WHERE thread_id = ? AND agent_id = ? ORDER BY seq ASC')
      .all(threadId, agentId)
      .map((row) => row.seq)
    const present = new Set(seqs)
    const gaps: number[] = []
    const max = seqs.at(-1) ?? 0
    for (let seq = 1; seq <= max; seq += 1) if (!present.has(seq)) gaps.push(seq)
    const report = segments.all(threadId, agentId).map((segment) => inspectSegment(threadId, agentId, segment))
    return {
      ok: gaps.length === 0 && report.every((segment) => segment.state !== 'corrupt'),
      gaps,
      segments: report,
      corruptSegments: report.filter((segment) => segment.state === 'corrupt').map((segment) => segment.id),
    }
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

    query(types, options = {}) {
      if (types.length === 0) return []
      const typePlaceholders = types.map(() => '?').join(', ')
      const where = [`type IN (${typePlaceholders})`]
      /* json_extract 对布尔返回 0 / 1：布尔条件按整数绑定，否则 SQLite 根本不认这个绑定值 */
      const params: (string | number)[] = [...types]
      if (options.threadId !== undefined) {
        where.push('thread_id = ?')
        params.push(options.threadId)
      }
      if (options.agentId !== undefined) {
        where.push('agent_id = ?')
        params.push(options.agentId)
      }
      for (const [field, value] of Object.entries(options.fields ?? {})) {
        /* 字段名只来自调用方的固定清单（不是用户输入），值一律走占位符 */
        where.push('json_extract(payload, ?) = ?')
        params.push(`$."${field}"`, typeof value === 'boolean' ? Number(value) : value)
      }
      params.push(options.limit ?? 500)
      const rows = db
        .prepare<QueryRow>(
          `SELECT thread_id, payload FROM journal_events
           WHERE ${where.join(' AND ')}
           ORDER BY thread_id ASC, seq ASC LIMIT ?`,
        )
        .all(...params)
      return rows.map((row) => ({
        threadId: row.thread_id,
        event: JSON.parse(row.payload) as AgentEvent,
      }))
    },

    latestSeq,
    integrity,

    clear(threadId) {
      return db.transaction(() => {
        const changes = clearEvents.run(threadId).changes
        clearSegments.run(threadId)
        return changes
      })
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
  {
    version: 2,
    name: 'segments',
    sql: `ALTER TABLE journal_events ADD COLUMN segment_id INTEGER;
CREATE TABLE journal_segments (
  thread_id  TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  segment_id INTEGER NOT NULL,
  start_seq  INTEGER NOT NULL,
  end_seq    INTEGER,
  event_count INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  checksum   TEXT,
  state      TEXT NOT NULL CHECK (state IN ('open', 'sealed', 'corrupt')),
  created_at INTEGER NOT NULL,
  sealed_at  INTEGER,
  PRIMARY KEY (thread_id, agent_id, segment_id)
);
CREATE INDEX journal_events_segment ON journal_events (thread_id, agent_id, segment_id, seq);`,
  },
] as const

export default defineCoreModule({
  id: 'journal',
  migrations: journalMigrations,
  setup(ctx) {
    ctx.services.provide(JournalServiceToken, createJournalRepository(ctx.db))
  },
})
