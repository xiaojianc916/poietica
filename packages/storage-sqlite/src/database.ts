import { Database as BunDatabase, type Statement } from 'bun:sqlite'
import { assertOwnTables, tablePrefix } from './sql-guard'

export type SqlValue = string | number | bigint | boolean | null | Uint8Array

/** 模块能拿到的唯一数据库对象：所有 SQL 在 prepare/exec 时检查只引用本模块前缀的表 */
export interface ModuleDatabase {
  readonly moduleId: string
  readonly prefix: string
  /** 预编译并缓存（同一 SQL 文本只编译一次） */
  prepare<Row = unknown>(sql: string): Statement<Row>
  /** 执行一段（可含多条语句的）SQL，无返回值；用于迁移 */
  exec(sql: string): void
  /** 同步事务：fn 抛错则回滚；可嵌套（内层自动用 SAVEPOINT） */
  transaction<T>(fn: () => T): T
}

export interface Database {
  /** 内核专用：不做前缀检查 */
  readonly raw: BunDatabase
  forModule(moduleId: string): ModuleDatabase
  close(): void
}

export function openDatabase(file: string): Database {
  const raw = new BunDatabase(file, { create: true, strict: true })
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA synchronous = NORMAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 5000')
  /*
   * 长连接的维护三件（数据库性能方案 D4）。Core 一个进程只开这一条连接、一开就是一整天：
   * - journal_size_limit：检查点之后把 -wal 截回 64 MiB 以内（一次大迁移 / 大批写入后不再永久占着那么大的文件）；
   * - analysis_limit + optimize(0x10002)：给查询规划器补上统计（sqlite_stat1）。每张表最多抽 400 行，开库只多花几毫秒；
   *   关库前再跑一次 optimize，把这一次会话里查过的表的统计刷新掉（SQLite 文档对长连接的推荐做法）。
   */
  raw.exec('PRAGMA journal_size_limit = 67108864')
  raw.exec('PRAGMA analysis_limit = 400')
  raw.exec('PRAGMA optimize = 0x10002')
  const modules = new Map<string, ModuleDatabase>()
  return {
    raw,
    forModule(moduleId) {
      let m = modules.get(moduleId)
      if (m === undefined) {
        m = createModuleDatabase(raw, moduleId)
        modules.set(moduleId, m)
      }
      return m
    },
    close() {
      try {
        raw.exec('PRAGMA optimize')
      } catch {
        /* 只读库、磁盘满：统计没刷上不影响关库 */
      }
      raw.close()
    },
  }
}

function createModuleDatabase(raw: BunDatabase, moduleId: string): ModuleDatabase {
  const prefix = tablePrefix(moduleId)
  const checked = new Set<string>()
  const guard = (sql: string) => {
    if (checked.has(sql)) return
    assertOwnTables(sql, prefix, moduleId)
    checked.add(sql)
  }
  return {
    moduleId,
    prefix,
    prepare<Row>(sql: string) {
      guard(sql)
      return raw.query(sql) as unknown as Statement<Row>
    },
    exec(sql) {
      guard(sql)
      raw.exec(sql)
    },
    transaction(fn) {
      return raw.transaction(fn)()
    },
  }
}
