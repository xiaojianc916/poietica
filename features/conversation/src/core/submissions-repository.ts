import type { ModuleDatabase } from '@poietica/storage-sqlite'
import type { SubmissionAttachment, SubmissionView } from '../contract'

/**
 * 提交表：每条提交在 Core 里都有一个**确定结局**并存进库 —— 要么变成真实的一轮，要么排队，
 * 要么失败；刷新或重开应用，失败的消息还在。表名按功能 id 前缀。
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
  /** turnId → clientTurnId（快照盖章用：把本机的提交号补到 turn 上）。 */
  mapByTurnId(threadId: string): ReadonlyMap<string, string>
  /**
   * 这一条线程里某个 turnId 对应的提交行。
   *
   * **必须带 threadId**：turnId 是每条会话各自从 `t1` 编的，只按 turnId 查会命中别的线程
   * （实测：界面上出现两个用户气泡，正是因为新线程的 t1 拿到了旧线程的提交号）。
   */
  findByTurnId(threadId: string, turnId: string): SubmissionRow | null
  update(clientTurnId: string, patch: Partial<Pick<SubmissionRow, 'status' | 'turnId' | 'error'>>): SubmissionRow | null
  delete(clientTurnId: string): void
  /**
   * Core 启动：`pending` / `queued` 一律收成 `core_restarted`。
   *
   * pending 是上一次进程没来得及交出去的；queued 是交给了 omp、排在它**内存里**的
   * 那一队 —— 队列随进程一起消失（R-08-5），留在库里只会让界面画一个永远不动的排队行。
   */
  failUndelivered(error: { code: string; message: string }): SubmissionRow[]
  /** Core 启动：`started` 太旧的清掉（7 天；真实轮次在会话文件里，这里清的只是账）。 */
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
      /* 只取两列：走部分索引 conversation_submissions_by_turn 不回表，也不为一张号表去解析每行的附件 / 技能 JSON */
      const out = new Map<string, string>()
      for (const r of db
        .prepare<{ turn_id: string; client_turn_id: string }>(
          'SELECT turn_id, client_turn_id FROM conversation_submissions WHERE thread_id = ? AND turn_id IS NOT NULL',
        )
        .all(threadId)) {
        out.set(r.turn_id, r.client_turn_id)
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
      /*
       * 一条语句改完并带回新行（RETURNING）：原先先整行读出来、在进程里拼好再整行写回，每改一次两趟；
       * rev 也在库里自增，不靠读出来的旧值。只写 patch 里给了的列 —— 没给的保持原样（与原先的展开合并同义）。
       */
      const sets = ['rev = rev + 1']
      const params: (string | null)[] = []
      if (patch.status !== undefined) {
        sets.push('status = ?')
        params.push(patch.status)
      }
      if (patch.turnId !== undefined) {
        sets.push('turn_id = ?')
        params.push(patch.turnId)
      }
      if (patch.error !== undefined) {
        sets.push('error_code = ?', 'error_message = ?')
        params.push(patch.error?.code ?? null, patch.error?.message ?? null)
      }
      const raw = db
        .prepare<Raw>(
          `UPDATE conversation_submissions SET ${sets.join(', ')} WHERE client_turn_id = ? RETURNING ${COLUMNS}`,
        )
        .get(...params, clientTurnId)
      return raw === null ? null : toRow(raw)
    },
    delete(clientTurnId) {
      run(`DELETE FROM conversation_submissions WHERE client_turn_id = ?`, clientTurnId)
    },
    failUndelivered(error) {
      /* 一条 UPDATE 收完（原先逐行「读一次、写一次」，每行各自一次提交）；顺序与 listByThread 一致，事件按创建先后发 */
      return db
        .prepare<Raw>(
          `UPDATE conversation_submissions
              SET status = 'failed', error_code = ?, error_message = ?, rev = rev + 1
            WHERE status IN ('pending', 'queued')
        RETURNING ${COLUMNS}`,
        )
        .all(error.code, error.message)
        .map(toRow)
        .sort((a, b) => a.createdAt - b.createdAt || (a.clientTurnId < b.clientTurnId ? -1 : 1))
    },
    deleteStaleTerminal(cutoff) {
      run(
        `DELETE FROM conversation_submissions
          WHERE status = 'started' AND updated_at < ?`,
        cutoff,
      )
    },
  }
}
