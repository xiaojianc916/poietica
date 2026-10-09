import { Database as BunDatabase, type Statement } from 'bun:sqlite'
import { assertOwnTables, tablePrefix } from './sql-guard'

export type SqlValue = string | number | bigint | boolean | null | Uint8Array
export type SqlParams = readonly SqlValue[] | Record<string, SqlValue>

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
