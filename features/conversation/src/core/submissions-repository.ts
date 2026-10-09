import type { ModuleDatabase } from '@poietica/storage-sqlite'
import type { SubmissionAttachment, SubmissionView } from '../contract'

/**
 * 提交表（「Core 即时回显」方案的第 3 条规则）：每条提交在 Core 里都有一个**确定结局**
 * 并且存进库 —— 要么变成真实的一轮，要么排队，要么失败；刷新或重开应用，失败的消息还在。
 *
 * 表名按功能 id 前缀（`conversation_`），SQL 只写在本文件（铁律 6）。
 */
export interface SubmissionRow {
  clientTurnId: string
  threadId: string
  text: string
  attachments: readonly SubmissionAttachment[]
  skills: readonly string[]
  requestedAs: 'turn' | 'steer' | 'followUp'
  status: SubmissionView['status']
  turnId: string | null
  error: { code: string; message: string } | null
  rev: number
  createdAt: number
  updatedAt: number
}

interface Raw {
  client_turn_id: string
  thread_id: string
  text: string
  attachments: string
  skills: string
  requested_as: string
  status: string
  turn_id: string | null
  error_code: string | null
  error_message: string | null
  rev: number
  created_at: number
  updated_at: number
}

const COLUMNS = `client_turn_id, thread_id, text, attachments, skills, requested_as, status,
  turn_id, error_code, error_message, rev, created_at, updated_at`

function toRow(r: Raw): SubmissionRow {
  return {
    clientTurnId: r.client_turn_id,
    threadId: r.thread_id,
    text: r.text,
    attachments: JSON.parse(r.attachments) as SubmissionAttachment[],
    skills: JSON.parse(r.skills) as string[],
    requestedAs: r.requested_as as SubmissionRow['requestedAs'],
    status: r.status as SubmissionRow['status'],
    turnId: r.turn_id,
    error: r.error_code === null ? null : { code: r.error_code, message: r.error_message ?? '' },
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function submissionOf(row: SubmissionRow): SubmissionView {
  return {
    clientTurnId: row.clientTurnId,
    threadId: row.threadId,
    text: row.text,
    attachments: [...row.attachments],
    skills: [...row.skills],
    deliverAs: row.requestedAs,
    status: row.status,
    turnId: row.turnId,
    error: row.error === null ? null : { ...row.error },
    rev: row.rev,
    createdAt: row.createdAt,
  }
}

export interface SubmissionsRepository {
  insert(row: SubmissionRow): void
  get(clientTurnId: string): SubmissionRow | null
  /** 这个线程的全部提交，按创建顺序（时间的先后就是屏幕上气泡的先后）。 */
  listByThread(threadId: string): SubmissionRow[]
  /** ## turnId → clientTurnId（快照盖章用：把本机的提交号补到 turn 上）。 */
  mapByTurnId(threadId: string): ReadonlyMap<string, string>
  /**
   * 这一条线程里某个 turnId 对应的提交行（事件路由每条 upsert 补号用）。
   *
   * **必须带 threadId**：turnId 是每条会话各自从 `t1` 编的，只按 turnId 查会命中别的
   * 线程（实测：界面上出现两个用户气泡，正是因为新线程的 t1 拿到了旧线程的提交号）。
   */
  findByTurnId(threadId: string, turnId: string): SubmissionRow | null
  update(clientTurnId: string, patch: Partial<Pick<SubmissionRow, 'status' | 'turnId' | 'error'>>): SubmissionRow | null
  delete(clientTurnId: string): void
  /** Core 启动：`pending` 一律收成 `core_restarted`（上一次进程没把它们交出去）。 */
  failPending(error: { code: string; message: string }): SubmissionRow[]
  /** Core 启动：`started` / `queued` 太旧的清掉（7 天）。 */
  deleteStaleTerminal(cutoff: number): void
}

export function createSubmissionsRepository(db: ModuleDatabase): SubmissionsRepository {
  const run = (sql: string, ...params: readonly (string | number | null)[]): void => {
    db.prepare(sql).run(...(params as never[]))
  }

  return {
    insert(row) {
      run(
        `INSERT INTO conversation_submissions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.clientTurnId,
        row.threadId,
        row.text,
        JSON.stringify(row.attachments),
        JSON.stringify(row.skills),
        row.requestedAs,
        row.status,
        row.turnId,
        row.error?.code ?? null,
        row.error?.message ?? null,
        row.rev,
        row.createdAt,
        row.updatedAt,
      )
    },
    get(clientTurnId) {
      const raw = db
        .prepare<Raw>(`SELECT ${COLUMNS} FROM conversation_submissions WHERE client_turn_id = ?`)
        .get(clientTurnId)
      return raw === null ? null : toRow(raw)
    },
    listByThread(threadId) {
      return db
        .prepare<Raw>(
          `SELECT ${COLUMNS} FROM conversation_submissions WHERE thread_id = ? ORDER BY created_at, client_turn_id`,
        )
        .all(threadId)
        .map(toRow)
    },
    mapByTurnId(threadId) {
      const out = new Map<string, string>()
      for (const row of db
        .prepare<Raw>(`SELECT ${COLUMNS} FROM conversation_submissions WHERE thread_id = ? AND turn_id IS NOT NULL`)
        .all(threadId)
        .map(toRow)) {
        if (row.turnId !== null) out.set(row.turnId, row.clientTurnId)
      }
      return out
    },
    findByTurnId(threadId, turnId) {
      const raw = db
        .prepare<Raw>(`SELECT ${COLUMNS} FROM conversation_submissions WHERE thread_id = ? AND turn_id = ? LIMIT 1`)
        .get(threadId, turnId)
      return raw === null ? null : toRow(raw)
    },
    update(clientTurnId, patch) {
      const current = this.get(clientTurnId)
      if (current === null) return null
      const next: SubmissionRow = {
        ...current,
        ...patch,
        rev: current.rev + 1,
      }
      run(
        `UPDATE conversation_submissions
           SET status = ?, turn_id = ?, error_code = ?, error_message = ?, rev = ?, updated_at = ?
         WHERE client_turn_id = ?`,
        next.status,
        next.turnId,
        next.error?.code ?? null,
        next.error?.message ?? null,
        next.rev,
        next.updatedAt,
        next.clientTurnId,
      )
      return next
    },
    delete(clientTurnId) {
      run(`DELETE FROM conversation_submissions WHERE client_turn_id = ?`, clientTurnId)
    },
    failPending(error) {
      const pending = db
        .prepare<Raw>(`SELECT ${COLUMNS} FROM conversation_submissions WHERE status = 'pending'`)
        .all()
        .map(toRow)
      return pending.map((row) => this.update(row.clientTurnId, { status: 'failed', error }) ?? row)
    },
    deleteStaleTerminal(cutoff) {
      run(
        `DELETE FROM conversation_submissions
          WHERE status IN ('started', 'queued') AND updated_at < ?`,
        cutoff,
      )
    },
  }
}
