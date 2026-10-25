import { describe, expect, test } from 'bun:test'
import { type Database, openDatabase } from '../database'
import { DataTooNewError, MigrationError, runMigrations } from '../migrations'

const M1 = { version: 1, name: 'init', sql: 'CREATE TABLE a_one (id TEXT PRIMARY KEY)' }
const M2 = { version: 2, name: 'add-two', sql: 'CREATE TABLE a_two (id TEXT PRIMARY KEY)' }
const M3 = { version: 3, name: 'add-three', sql: 'CREATE TABLE a_three (id TEXT PRIMARY KEY)' }
const B1 = { version: 1, name: 'init', sql: 'CREATE TABLE b_one (id TEXT PRIMARY KEY)' }

function versionOf(db: Database, moduleId: string): number | null {
  const row = db.raw.query('SELECT version FROM kernel_migrations WHERE module = ?').get(moduleId) as {
    version: number
  } | null
  return row?.version ?? null
}

function appliedAt(db: Database, moduleId: string): number | null {
  const row = db.raw.query('SELECT applied_at FROM kernel_migrations WHERE module = ?').get(moduleId) as {
    applied_at: number
  } | null
  return row?.applied_at ?? null
}

function tableNames(db: Database): string[] {
  return (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (r) => r.name,
  )
}

describe('runMigrations', () => {
  // DB-5：首次执行 2 个迁移 → version=2；再次执行无操作；追加第 3 个只执行第 3 个
  test('DB-5 首次执行、重复执行、追加迁移', () => {
    const db = openDatabase(':memory:')
    try {
      runMigrations(db, [{ moduleId: 'a', migrations: [M1, M2] }], () => 1000)
      expect(versionOf(db, 'a')).toBe(2)
      expect(appliedAt(db, 'a')).toBe(1000)
      expect(tableNames(db)).toContain('a_one')
      expect(tableNames(db)).toContain('a_two')

      // 迁移 1、2 的 DDL 没有 IF NOT EXISTS：重复执行会抛错，因此“无操作”是必然的
      runMigrations(db, [{ moduleId: 'a', migrations: [M1, M2] }], () => 2000)
      expect(versionOf(db, 'a')).toBe(2)
      expect(appliedAt(db, 'a')).toBe(1000)

      runMigrations(db, [{ moduleId: 'a', migrations: [M1, M2, M3] }], () => 3000)
      expect(versionOf(db, 'a')).toBe(3)
      expect(appliedAt(db, 'a')).toBe(3000)
      expect(tableNames(db)).toContain('a_three')
    } finally {
      db.close()
    }
  })

  // DB-6：版本号必须从 1 连续递增 —— 不从 1 起、中间断号，两档都拒
  test('DB-6 版本号不从 1 开始 → MigrationError', () => {
    const db = openDatabase(':memory:')
    try {
      expect(() =>
        runMigrations(db, [
          { moduleId: 'a', migrations: [{ version: 2, name: 'skip', sql: 'CREATE TABLE a_two (id TEXT)' }] },
        ]),
      ).toThrow(MigrationError)
      expect(versionOf(db, 'a')).toBeNull()
      expect(tableNames(db)).not.toContain('a_two')
    } finally {
      db.close()
    }
  })

  test('DB-6 版本号中间断号 → MigrationError，且一条都没执行', () => {
    const db = openDatabase(':memory:')
    try {
      expect(() => runMigrations(db, [{ moduleId: 'a', migrations: [M1, M3] }])).toThrow(MigrationError)
      /* 校验在开事务之前：断号时连第 1 条都不落地 */
      expect(versionOf(db, 'a')).toBeNull()
      expect(tableNames(db)).not.toContain('a_one')
      expect(tableNames(db)).not.toContain('a_three')
    } finally {
      db.close()
    }
  })

  const BROKEN = {
    version: 2,
    name: 'broken',
    sql: 'CREATE TABLE a_two (id TEXT PRIMARY KEY); INSERT INTO a_missing (id) VALUES (1)',
  }

  // DB-7：迁移 1 与迁移 2 在同一次执行里 → 整块回滚，模块回到“未迁移”（没有版本行、表不存在）
  test('DB-7 同一次执行内失败：该模块回到未迁移状态', () => {
    const db = openDatabase(':memory:')
    try {
      // b 排在 a 前面：b 已提交，a 抛错后整个 runMigrations 中止
      expect(() =>
        runMigrations(db, [
          { moduleId: 'b', migrations: [B1] },
          { moduleId: 'a', migrations: [M1, BROKEN] },
        ]),
      ).toThrow()
      expect(versionOf(db, 'a')).toBeNull()
      expect(tableNames(db)).not.toContain('a_one')
      expect(tableNames(db)).not.toContain('a_two')
      // 其它模块不受影响（已提交的保持）
      expect(versionOf(db, 'b')).toBe(1)
      expect(tableNames(db)).toContain('b_one')
    } finally {
      db.close()
    }
  })

  // DB-7：迁移 1 已提交、之后追加的迁移 2 抛错 → 该模块版本仍为 1 且迁移 2 创建的表不存在；其它模块不受影响
  test('DB-7 追加迁移失败：版本停在 1，迁移 2 的表不存在', () => {
    const db = openDatabase(':memory:')
    try {
      runMigrations(
        db,
        [
          { moduleId: 'a', migrations: [M1] },
          { moduleId: 'b', migrations: [B1] },
        ],
        () => 1000,
      )
      expect(() =>
        runMigrations(
          db,
          [
            { moduleId: 'a', migrations: [M1, BROKEN] },
            { moduleId: 'b', migrations: [B1] },
          ],
          () => 2000,
        ),
      ).toThrow()
      expect(versionOf(db, 'a')).toBe(1)
      expect(appliedAt(db, 'a')).toBe(1000)
      expect(tableNames(db)).toContain('a_one')
      expect(tableNames(db)).not.toContain('a_two')
      expect(versionOf(db, 'b')).toBe(1)
      expect(tableNames(db)).toContain('b_one')
    } finally {
      db.close()
    }
  })

  /*
   * DB-8：数据库版本高于程序已知 → **DataTooNewError**（不是普通 MigrationError）。
   * 点名子类是这条用例的全部意义：Host 只对 DataTooNewError 立刻进 failed/data_too_new（退出码 4），
   * 换成父类会被当成普通迁移失败，退避重启五轮后报成 crash_loop（R-08-8）。
   */
  test('DB-8 数据库来自更新的版本 → DataTooNewError（且是 MigrationError 的子类）', () => {
    const db = openDatabase(':memory:')
    try {
      runMigrations(db, [{ moduleId: 'a', migrations: [M1, M2, M3] }], () => 1000)
      expect(versionOf(db, 'a')).toBe(3)
      let thrown: unknown = null
      try {
        runMigrations(db, [{ moduleId: 'a', migrations: [M1, M2] }], () => 2000)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(DataTooNewError)
      expect(thrown).toBeInstanceOf(MigrationError)
      /* 拒绝时不写版本行：库仍是旧版本、applied_at 不动 */
      expect(versionOf(db, 'a')).toBe(3)
      expect(appliedAt(db, 'a')).toBe(1000)
    } finally {
      db.close()
    }
  })

  /* 折叠成单条 init 之后每个模块只有 1 条迁移：残留的旧库（版本 2 及以上）一律走上面那条路 */
  test('DB-8 单条 init 的模块遇到版本 2 的旧库 → DataTooNewError', () => {
    const db = openDatabase(':memory:')
    try {
      runMigrations(db, [{ moduleId: 'a', migrations: [M1, M2] }], () => 1000)
      expect(() => runMigrations(db, [{ moduleId: 'a', migrations: [M1] }], () => 2000)).toThrow(DataTooNewError)
      expect(versionOf(db, 'a')).toBe(2)
    } finally {
      db.close()
    }
  })

  // DB-9：嵌套 transaction 内层抛错被外层捕获 → 只回滚内层
  test('DB-9 嵌套事务内层回滚，外层提交', () => {
    const db = openDatabase(':memory:')
    try {
      const mdb = db.forModule('a')
      mdb.exec('CREATE TABLE a_x (id TEXT PRIMARY KEY, n INTEGER NOT NULL)')
      mdb.transaction(() => {
        mdb.prepare('INSERT INTO a_x (id, n) VALUES (?, ?)').run('outer', 1)
        try {
          mdb.transaction(() => {
            mdb.prepare('INSERT INTO a_x (id, n) VALUES (?, ?)').run('inner', 2)
            throw new Error('inner boom')
          })
        } catch (error) {
          expect((error as Error).message).toBe('inner boom')
        }
      })
      expect(mdb.prepare('SELECT id FROM a_x ORDER BY id').all()).toEqual([{ id: 'outer' }])
    } finally {
      db.close()
    }
  })
})
