import type { ModuleDatabase } from '@poietica/storage-sqlite'

/**
 * 会话文件回收队列（迁移 v4 的 `conversation_reclaim`）。线程行删除时在**同一个库事务里**入队，
 * 物理删除在事务之后尝试：成功出队，失败记下原因留着，下次启动重试。
 *
 * 这样「删除一条线程」在用户看来只有一步（库里的行没了就是删了），而文件那一侧的失败只是一笔待办的账，
 * 不会再把线程卡在半删状态。
 */
export interface ReclaimEntry {
  readonly sessionFile: string
  readonly threadId: string
  readonly attempts: number
  readonly lastError: string | null
}

export interface ReclaimRepository {
  /** 入队；同一路径重复入队只刷新时间（幂等） */
  enqueue(sessionFile: string, threadId: string, now: number): void
  /** 待回收的，先进先出 */
  pending(): ReclaimEntry[]
  /** 删掉了（或本来就不在）：出队 */
  done(sessionFile: string): void
  /** 没删掉：记一次失败，留在队里 */
  failed(sessionFile: string, error: string, now: number): void
}

interface Row {
  session_file: string
  thread_id: string
  attempts: number
  last_error: string | null
}

export function createReclaimRepository(db: ModuleDatabase): ReclaimRepository {
  return {
    enqueue(sessionFile, threadId, now) {
      db.prepare(
        `INSERT INTO conversation_reclaim (session_file, thread_id, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, 0, NULL, ?, ?)
         ON CONFLICT (session_file) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
      ).run(sessionFile, threadId, now, now)
    },
    pending() {
      return db
        .prepare<Row>(
          'SELECT session_file, thread_id, attempts, last_error FROM conversation_reclaim ORDER BY created_at, session_file',
        )
        .all()
        .map((r) => ({
          sessionFile: r.session_file,
          threadId: r.thread_id,
          attempts: r.attempts,
          lastError: r.last_error,
        }))
    },
    done(sessionFile) {
      db.prepare('DELETE FROM conversation_reclaim WHERE session_file = ?').run(sessionFile)
    },
    failed(sessionFile, error, now) {
      db.prepare(
        'UPDATE conversation_reclaim SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE session_file = ?',
      ).run(error, now, sessionFile)
    },
  }
}
