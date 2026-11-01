import { createHash } from 'node:crypto'
import type { Database } from './database'

export interface Migration {
  /** 从 1 开始连续递增 */
  readonly version: number
  /** kebab-case 简述，例如 'create-threads' */
  readonly name: string
  /** 纯 SQL（可多条语句）。只增不改：要改表就追加一条新的 */
  readonly sql: string
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
  override readonly name: string = 'DataTooNewError'
}

/**
 * 已落地的迁移链与当前代码里的那条链对不上（偏差 #82 之后的常见形态：改表直接改了 `init`，版本号没动）。
 * 版本号相同时以前直接跳过 —— 库里还是旧表，运行时才在某条 SQL 上报 `no such column`。
 * 这是确定性失败（重启多少次都一样），所以和 DataTooNewError 一样不该进退避：归 MigrationError → 退出码 5。
 */
export class SchemaDriftError extends MigrationError {
  override readonly name: string = 'SchemaDriftError'
}

const KERNEL_DDL = `CREATE TABLE IF NOT EXISTS kernel_migrations (
  module     TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  checksum   TEXT
)`

/** 早于 checksum 列建出来的库：补上这一列（NULL = 还没记过指纹，下次启动按当前代码补记） */
function ensureChecksumColumn(db: Database): void {
  const columns = db.raw.query('PRAGMA table_info(kernel_migrations)').all() as { name: string }[]
  if (!columns.some((c) => c.name === 'checksum')) db.raw.exec('ALTER TABLE kernel_migrations ADD COLUMN checksum TEXT')
}

/**
 * 迁移链的指纹：只看 SQL 的语义部分 —— 去掉注释、压掉空白（括号、逗号、分号两侧的空白全去），改注释或缩进不算改表。
 * 不是完整的 SQL 词法：字符串字面量里的 `--` 也会被当注释（DDL 的默认值里几乎不会出现）。
 */
export function migrationChecksum(migrations: readonly Migration[]): string {
  const hash = createHash('sha256')
  for (const m of migrations) {
    const sql = m.sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/ ?([(),;]) ?/g, '$1')
      .trim()
    hash.update(`${m.version}\u0000${sql}\u0000`)
  }
  return hash.digest('hex')
}

/** 按传入顺序（内核已做拓扑排序）为每个模块执行未应用的迁移；每个模块一个事务 */
export function runMigrations(db: Database, modules: readonly ModuleMigrations[], now: () => number = Date.now): void {
  db.raw.exec(KERNEL_DDL)
  ensureChecksumColumn(db)
  const getVersion = db.raw.query('SELECT version, checksum FROM kernel_migrations WHERE module = ?')
  const setVersion = db.raw.query(
    'INSERT INTO kernel_migrations (module, version, applied_at, checksum) VALUES (?, ?, ?, ?) ON CONFLICT(module) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at, checksum = excluded.checksum',
  )
  const setChecksum = db.raw.query('UPDATE kernel_migrations SET checksum = ? WHERE module = ?')
  for (const { moduleId, migrations } of modules) {
    migrations.forEach((m, i) => {
      if (m.version !== i + 1)
        throw new MigrationError(`模块 ${moduleId} 的迁移版本必须从 1 连续递增，第 ${i + 1} 个是 ${m.version}`)
    })
    const row = getVersion.get(moduleId) as { version: number; checksum: string | null } | null
    const current = row?.version ?? 0
    if (current > migrations.length) {
      throw new DataTooNewError(
        `数据库中模块 ${moduleId} 的版本 ${current} 高于程序已知的 ${migrations.length}：数据库来自更新的 Poietica 版本`,
      )
    }
    /* 已落地的那一段必须与代码里同版本号的那一段逐条一致，否则库里的表不是代码以为的表 */
    const appliedChecksum = migrationChecksum(migrations.slice(0, current))
    if (row !== null && row.checksum !== null && row.checksum !== appliedChecksum) {
      throw new SchemaDriftError(
        `模块 ${moduleId} 的前 ${current} 条迁移与数据库里已执行的不一致（多半是直接改了已发布的 init）：` +
          '已有的库不会再执行它，表结构与代码对不上。要么追加一条新迁移，要么删掉这份数据库重建',
      )
    }
    if (current === migrations.length) {
      /* 早于指纹列的库：信任当前代码，补记一次 */
      if (row !== null && row.checksum === null) setChecksum.run(appliedChecksum, moduleId)
      continue
    }
    const mdb = db.forModule(moduleId)
    db.raw.transaction(() => {
      for (const m of migrations.slice(current)) mdb.exec(m.sql)
      setVersion.run(moduleId, migrations.length, now(), migrationChecksum(migrations))
    })()
  }
}
