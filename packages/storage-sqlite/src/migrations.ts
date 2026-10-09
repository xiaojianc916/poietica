import type { Database, ModuleDatabase } from './database'

export interface Migration {
  /** 从 1 开始连续递增 */
  readonly version: number
  /** kebab-case 简述，例如 'create-threads' */
  readonly name: string
  /** 二选一：纯 SQL（可多条语句），或用代码迁移（需要数据变换时） */
  readonly sql?: string
  readonly up?: (db: ModuleDatabase) => void
}

export interface ModuleMigrations {
  readonly moduleId: string
  readonly migrations: readonly Migration[]
}

export class MigrationError extends Error {
  override readonly name: string = 'MigrationError'
}

/**
 * 数据库版本高于本程序已知的迁移（降级安装）。单独一类是因为它该走**退出码 4**：
 * Host 见到 4 直接进 failed/data_too_new，不再退避重启五轮后报成 crash_loop（R-08-8）。
 */
export class DataTooNewError extends MigrationError {
  override readonly name = 'DataTooNewError'
}

const KERNEL_DDL = `CREATE TABLE IF NOT EXISTS kernel_migrations (
  module     TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
)`

/** 按传入顺序（内核已做拓扑排序）为每个模块执行未应用的迁移；每个模块一个事务 */
export function runMigrations(db: Database, modules: readonly ModuleMigrations[], now: () => number = Date.now): void {
  db.raw.exec(KERNEL_DDL)
  const getVersion = db.raw.query('SELECT version FROM kernel_migrations WHERE module = ?')
  const setVersion = db.raw.query(
    'INSERT INTO kernel_migrations (module, version, applied_at) VALUES (?, ?, ?) ON CONFLICT(module) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at',
  )
  for (const { moduleId, migrations } of modules) {
    migrations.forEach((m, i) => {
      if (m.version !== i + 1)
        throw new MigrationError(`模块 ${moduleId} 的迁移版本必须从 1 连续递增，第 ${i + 1} 个是 ${m.version}`)
      if ((m.sql === undefined) === (m.up === undefined))
        throw new MigrationError(`模块 ${moduleId} 的迁移 ${m.version} 必须且只能提供 sql 或 up 之一`)
    })
    const row = getVersion.get(moduleId) as { version: number } | null
    const current = row?.version ?? 0
    if (current > migrations.length) {
      throw new DataTooNewError(
        `数据库中模块 ${moduleId} 的版本 ${current} 高于程序已知的 ${migrations.length}：数据库来自更新的 Poietica 版本`,
      )
    }
    if (current === migrations.length) continue
    const mdb = db.forModule(moduleId)
    db.raw.transaction(() => {
      for (const m of migrations.slice(current)) {
        if (m.sql !== undefined) mdb.exec(m.sql)
        else m.up!(mdb)
      }
      setVersion.run(moduleId, migrations.length, now())
    })()
  }
}
