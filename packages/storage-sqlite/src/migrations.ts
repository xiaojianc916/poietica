import { createHash } from 'node:crypto'
import type { Database } from './database'
import { tablePrefix } from './sql-guard'

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

export interface PendingMigration {
  readonly moduleId: string
  /** 库里已到的版本（0 = 还没建过） */
  readonly from: number
  /** 代码里的最新版本 */
  readonly to: number
}

export interface TooNewModule {
  readonly moduleId: string
  readonly dbVersion: number
  readonly codeVersion: number
}

/**
 * 启动前的迁移计划（ADR-004）：先算清楚「要做什么」，内核再决定备份、执行，或者以只读模式打开。
 * - `tooNew` 非空：库来自更新的 Poietica（降级安装）。不执行任何迁移，内核以只读模式打开；
 * - `pending` 非空：有待执行的前向迁移。内核先做在线备份，再在**一个事务**里全部执行。
 * 迁移链不连续、已落地的那一段被改过（SchemaDriftError）仍然直接抛：那是代码错误，不是数据状态。
 */
export interface MigrationPlan {
  readonly pending: readonly PendingMigration[]
  readonly tooNew: readonly TooNewModule[]
}

function ensureKernelTable(db: Database): void {
  db.raw.exec(KERNEL_DDL)
  ensureChecksumColumn(db)
}

function assertConsecutive(moduleId: string, migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new MigrationError(`模块 ${moduleId} 的迁移版本必须从 1 连续递增，第 ${i + 1} 个是 ${m.version}`)
  })
}

interface AppliedRow {
  readonly version: number
  readonly checksum: string | null
}

function appliedRowOf(db: Database, moduleId: string): AppliedRow | null {
  return (db.raw.query('SELECT version, checksum FROM kernel_migrations WHERE module = ?').get(moduleId) ??
    null) as AppliedRow | null
}

function readAppliedRow(db: Database, moduleId: string, hasTable: boolean, hasChecksum: boolean): AppliedRow | null {
  if (!hasTable) return null
  return (db.raw
    .query(`SELECT version, ${hasChecksum ? 'checksum' : 'NULL AS checksum'} FROM kernel_migrations WHERE module = ?`)
    .get(moduleId) ?? null) as AppliedRow | null
}

/** 只读：不建表、不补指纹。库是只读打开的也能算 */
export function planMigrations(db: Database, modules: readonly ModuleMigrations[]): MigrationPlan {
  const hasKernelTable =
    db.raw.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kernel_migrations'").get() !== null
  const hasChecksum =
    hasKernelTable &&
    (db.raw.query('PRAGMA table_info(kernel_migrations)').all() as { name: string }[]).some(
      (c) => c.name === 'checksum',
    )
  const pending: PendingMigration[] = []
  const tooNew: TooNewModule[] = []
  for (const { moduleId, migrations } of modules) {
    assertConsecutive(moduleId, migrations)
    const row = readAppliedRow(db, moduleId, hasKernelTable, hasChecksum)
    const current = row?.version ?? 0
    if (current > migrations.length) {
      tooNew.push({ moduleId, dbVersion: current, codeVersion: migrations.length })
      continue
    }
    /* 已落地的那一段必须与代码里同版本号的那一段逐条一致，否则库里的表不是代码以为的表 */
    if (row?.checksum && row.checksum !== migrationChecksum(migrations.slice(0, current))) {
      throw new SchemaDriftError(
        `模块 ${moduleId} 的前 ${current} 条迁移与数据库里已执行的不一致（多半是直接改了已发布的迁移）：` +
          '已有的库不会再执行它，表结构与代码对不上。已发布的迁移只能追加，不能修改（ADR-004）',
      )
    }
    if (current < migrations.length) pending.push({ moduleId, from: current, to: migrations.length })
  }
  return { pending, tooNew }
}

/**
 * 按传入顺序（内核已做拓扑排序）执行全部未应用的迁移，**整批一个事务**（ADR-004）：
 * SQLite 的 DDL 也在事务里，任何一条失败都整批回滚，库回到迁移前的样子，不会停在「前几个模块升了、后几个没升」的半截状态。
 */
export function runMigrations(db: Database, modules: readonly ModuleMigrations[], now: () => number = Date.now): void {
  ensureKernelTable(db)
  const plan = planMigrations(db, modules)
  const firstTooNew = plan.tooNew[0]
  if (firstTooNew !== undefined) {
    throw new DataTooNewError(
      `数据库中模块 ${firstTooNew.moduleId} 的版本 ${firstTooNew.dbVersion} 高于程序已知的 ${firstTooNew.codeVersion}：数据库来自更新的 Poietica 版本`,
    )
  }
  const setVersion = db.raw.query(
    'INSERT INTO kernel_migrations (module, version, applied_at, checksum) VALUES (?, ?, ?, ?) ON CONFLICT(module) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at, checksum = excluded.checksum',
  )
  const setChecksum = db.raw.query('UPDATE kernel_migrations SET checksum = ? WHERE module = ?')
  const pendingOf = new Map(plan.pending.map((p) => [p.moduleId, p]))
  db.raw.transaction(() => {
    for (const { moduleId, migrations } of modules) {
      const pending = pendingOf.get(moduleId)
      if (pending === undefined) {
        /* 早于指纹列的库：信任当前代码，补记一次 */
        const row = appliedRowOf(db, moduleId)
        if (row !== null && row.checksum === null) setChecksum.run(migrationChecksum(migrations), moduleId)
        continue
      }
      const mdb = db.forModule(moduleId)
      for (const m of migrations.slice(pending.from)) mdb.exec(m.sql)
      setVersion.run(moduleId, migrations.length, now(), migrationChecksum(migrations))
    }
  })()
}

/**
 * 已退役模块留在库里的表：整组删掉，并抹掉它在 kernel_migrations 里的那一行。
 * 先开 secure_delete 再删，被释放的页用零覆盖 —— 退役的数据里可能有明文凭据，不能只是「标记为空闲」。
 * 必须在备份之前跑：否则迁移前备份会把这些数据再复制一份。返回真的清掉了东西的模块 id。
 */
export function purgeRetiredModules(db: Database, moduleIds: readonly string[]): readonly string[] {
  if (moduleIds.length === 0) return []
  const purged: string[] = []
  const hasKernelTable =
    db.raw.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kernel_migrations'").get() !== null
  db.raw.exec('PRAGMA secure_delete = ON')
  try {
    db.raw.transaction(() => {
      for (const moduleId of moduleIds) {
        if (purgeOneRetiredModule(db, moduleId, hasKernelTable)) purged.push(moduleId)
      }
    })()
    /* WAL 里还留着删除前的页：截断检查点，让它们也从磁盘上消失 */
    if (purged.length > 0) db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.raw.exec('PRAGMA secure_delete = OFF')
  }
  return purged
}

function purgeOneRetiredModule(db: Database, moduleId: string, hasKernelTable: boolean): boolean {
  const prefix = `${tablePrefix(moduleId)}_`
  const objects = db.raw
    .query(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND substr(name, 1, length(?)) = ? ORDER BY type",
    )
    .all(prefix, prefix) as { type: 'table' | 'view'; name: string }[]
  const hadRow =
    hasKernelTable && db.raw.query('SELECT 1 FROM kernel_migrations WHERE module = ?').get(moduleId) !== null
  if (objects.length === 0 && !hadRow) return false
  for (const o of objects) db.raw.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${o.name}"`)
  if (hadRow) db.raw.query('DELETE FROM kernel_migrations WHERE module = ?').run(moduleId)
  return true
}
