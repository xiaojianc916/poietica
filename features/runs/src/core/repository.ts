import type { SubmissionAttachment } from '@poietica/product-model'
import type { ModuleDatabase } from '@poietica/storage-sqlite'
import type { SubmissionRow, SubmissionsRepository } from '../core-api'

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
