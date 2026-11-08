import type { CoreModule, RetiredCoreModule } from '@poietica/core-kernel'
import { type Database, migrationChecksum, openDatabase, planMigrations, runMigrations } from '@poietica/storage-sqlite'

/**
 * 已发布版本的库结构快照（ADR-004「已发布版本迁移测试」）。每发一个版本，`bun run schema:snapshot`
 * 把那一版的库结构写进 `apps/core/schema/released/v<版本>.json`；之后的每个版本都必须能把这些库**原地升级**
 * 到与全新安装一模一样的结构 —— 改了已发布的迁移、或者新迁移漏了什么，这条测试就红。
 */
export interface SchemaSnapshot {
  readonly coreVersion: string
  /** 每个模块已应用到的版本与指纹（kernel_migrations 的那一行） */
  readonly modules: Readonly<Record<string, { readonly version: number; readonly checksum: string }>>
  /** sqlite_master 里的对象，按创建顺序；kernel_migrations 自己不在里面 */
  readonly objects: readonly SchemaObject[]
}

export interface SchemaObject {
  readonly type: string
  readonly name: string
  readonly sql: string
}

const toPlan = (modules: readonly CoreModule[]) =>
  modules.map((m) => ({ moduleId: m.id, migrations: m.migrations ?? [] }))

/** 当前代码的全新安装：在内存库里跑一遍全部迁移，记下结构 */
export function buildSchemaSnapshot(coreVersion: string, modules: readonly CoreModule[]): SchemaSnapshot {
  const db = openDatabase(':memory:')
  try {
    runMigrations(db, toPlan(modules), () => 0)
    const versions: Record<string, { version: number; checksum: string }> = {}
    for (const m of modules) {
      const migrations = m.migrations ?? []
      if (migrations.length === 0) continue
      versions[m.id] = { version: migrations.length, checksum: migrationChecksum(migrations) }
    }
    return { coreVersion, modules: versions, objects: dumpObjects(db) }
  } finally {
    db.close()
  }
}

/** 按快照重建一份「那个版本留下的库」（结构 + kernel_migrations），供升级测试用 */
export function restoreSchemaSnapshot(snapshot: SchemaSnapshot): Database {
  const db = openDatabase(':memory:')
  db.raw.exec(
    'CREATE TABLE kernel_migrations (module TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT)',
  )
  for (const object of snapshot.objects) db.raw.exec(object.sql)
  const insert = db.raw.query(
    'INSERT INTO kernel_migrations (module, version, applied_at, checksum) VALUES (?, ?, 0, ?)',
  )
  for (const [module, row] of Object.entries(snapshot.modules)) insert.run(module, row.version, row.checksum)
  return db
}

/**
 * 内核启动时对旧库做的那几步（保留退役数据 → 算计划 → 整批迁移），返回升级后的结构。
 * 计划里有「库比程序新」就直接抛：已发布的库永远不该比后来的程序新。
 */
export function upgradeSnapshot(
  snapshot: SchemaSnapshot,
  modules: readonly CoreModule[],
  _retired: readonly RetiredCoreModule[],
): readonly SchemaObject[] {
  const db = restoreSchemaSnapshot(snapshot)
  try {
    const plan = planMigrations(db, toPlan(modules))
    if (plan.tooNew.length > 0) {
      throw new Error(`v${snapshot.coreVersion} 的库比当前代码新：${plan.tooNew.map((t) => t.moduleId).join(', ')}`)
    }
    runMigrations(db, toPlan(modules), () => 0)
    return dumpObjects(db)
  } finally {
    db.close()
  }
}

function dumpObjects(db: Database): SchemaObject[] {
  const rows = db.raw
    .query(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'kernel_migrations' ORDER BY rowid",
    )
    .all() as { type: string; name: string; sql: string }[]
  /* 原样保存（DDL 里可能有 `--` 注释，压空白会把后半句注释掉） */
  return rows.map((r) => ({ type: r.type, name: r.name, sql: r.sql }))
}

/** 比较用：与创建顺序无关，只抹掉行尾空白差异 */
export function byName(objects: readonly SchemaObject[]): SchemaObject[] {
  return objects
    .map((o) => ({ ...o, sql: o.sql.replace(/[ \t]+$/gm, '') }))
    .sort((a, b) => (a.type + a.name < b.type + b.name ? -1 : a.type + a.name > b.type + b.name ? 1 : 0))
}
