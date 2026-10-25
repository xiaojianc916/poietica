import type { ModuleDatabase } from '@poietica/storage-sqlite'

/**
 * 一轮文件改动的账本（表结构见 migrations.ts）。
 *
 * 键是（线程, 轮, 路径）；写入是 upsert —— 同一轮同一文件被工具改多次时，**保留最初那次 before**
 * （撤销要回到这一轮开始之前），after 更新到最新（最后落在盘上的是它）。
 */
export interface TurnFileRow {
  readonly threadId: string
  readonly turn: number
  /** 绝对路径（落账时按工作区根解析过）。 */
  readonly path: string
  /** 写之前那一份；null = 写之前这个文件不存在。 */
  readonly before: string | null
  /** 写之后那一份；null = 这一笔把它删了。 */
  readonly after: string | null
  readonly state: 'applied' | 'reverted'
  readonly createdAt: number
}

interface Raw {
  thread_id: string
  turn: number
  path: string
  before: string | null
  after: string | null
  state: string
  created_at: number
}

const COLUMNS = 'thread_id, turn, path, before, after, state, created_at'

function toRow(r: Raw): TurnFileRow {
  return {
    threadId: r.thread_id,
    turn: r.turn,
    path: r.path,
    before: r.before,
    after: r.after,
    state: r.state as TurnFileRow['state'],
    createdAt: r.created_at,
  }
}

export interface TurnFilesRepository {
  /** 同一轮同一文件再写一次：before 保持原样，after 换成最新。 */
  upsert(row: Omit<TurnFileRow, 'state'>): void
  listByThread(threadId: string): TurnFileRow[]
  /** 这一轮的全部行；没有就返回空数组（调用方据此报 rewind_not_available）。 */
  listByTurn(threadId: string, turn: number): TurnFileRow[]
  /** 撤销以轮为单位：同轮的每一行一起翻成 reverted。 */
  markReverted(threadId: string, turn: number): void
  removeThread(threadId: string): void
}

export function createTurnFilesRepository(db: ModuleDatabase): TurnFilesRepository {
  const run = (sql: string, ...params: readonly (string | number | null)[]): void => {
    db.prepare(sql).run(...(params as never[]))
  }

  return {
    upsert(row) {
      /*
       * before 只在插入时写（COALESCE 也行，但 ON CONFLICT 里最直白的是不碰它）：第一笔之前文件是否
       * 存在，是撤销唯一的信息，后面几笔的 before 是上一笔的 after，拿它当撤销目标就只退了一步。
       */
      run(
        `INSERT INTO review_turn_files (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 'applied', ?)
         ON CONFLICT (thread_id, turn, path) DO UPDATE SET after = excluded.after`,
        row.threadId,
        row.turn,
        row.path,
        row.before,
        row.after,
        row.createdAt,
      )
    },
    listByThread(threadId) {
      return db
        .prepare<Raw>(`SELECT ${COLUMNS} FROM review_turn_files WHERE thread_id = ? ORDER BY turn, path`)
        .all(threadId)
        .map(toRow)
    },
    listByTurn(threadId, turn) {
      return db
        .prepare<Raw>(`SELECT ${COLUMNS} FROM review_turn_files WHERE thread_id = ? AND turn = ? ORDER BY path`)
        .all(threadId, turn)
        .map(toRow)
    },
    markReverted(threadId, turn) {
      run("UPDATE review_turn_files SET state = 'reverted' WHERE thread_id = ? AND turn = ?", threadId, turn)
    },
    removeThread(threadId) {
      run('DELETE FROM review_turn_files WHERE thread_id = ?', threadId)
    },
  }
}
