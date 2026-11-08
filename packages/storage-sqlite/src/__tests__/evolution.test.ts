import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { backupDatabase, listBackups } from '../backup'
import { openDatabase } from '../database'
import { MigrationError, planMigrations, purgeRetiredModules, runMigrations } from '../migrations'

const A1 = { version: 1, name: 'init', sql: 'CREATE TABLE a_one (id TEXT PRIMARY KEY)' }
const A2 = { version: 2, name: 'add-two', sql: 'CREATE TABLE a_two (id TEXT PRIMARY KEY)' }
const B1 = { version: 1, name: 'init', sql: 'CREATE TABLE b_one (id TEXT PRIMARY KEY)' }
const B2_BROKEN = {
  version: 2,
  name: 'broken',
  sql: 'CREATE TABLE b_two (id TEXT PRIMARY KEY); INSERT INTO b_missing VALUES (1)',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'poietica-db-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const tables = (db: ReturnType<typeof openDatabase>): string[] =>
  (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  )

describe('planMigrations（ADR-004）', () => {
  test('新库：每个模块都是 0 → N 的待执行迁移；不建 kernel 表', () => {
    const db = openDatabase(':memory:')
    const plan = planMigrations(db, [
      { moduleId: 'a', migrations: [A1, A2] },
      { moduleId: 'b', migrations: [B1] },
    ])
    expect(plan.pending).toEqual([
      { moduleId: 'a', from: 0, to: 2 },
      { moduleId: 'b', from: 0, to: 1 },
    ])
    expect(plan.tooNew).toEqual([])
    expect(tables(db)).toEqual([])
    db.close()
  })

  test('库比程序新：列进 tooNew，不抛错（内核据此以只读打开）', () => {
    const db = openDatabase(':memory:')
    runMigrations(db, [{ moduleId: 'a', migrations: [A1, A2] }])
    const plan = planMigrations(db, [{ moduleId: 'a', migrations: [A1] }])
    expect(plan.tooNew).toEqual([{ moduleId: 'a', dbVersion: 2, codeVersion: 1 }])
    db.close()
  })

  test('版本号不连续仍是代码错误', () => {
    const db = openDatabase(':memory:')
    expect(() => planMigrations(db, [{ moduleId: 'a', migrations: [A2] }])).toThrow(MigrationError)
    db.close()
  })
})

describe('runMigrations 整批一个事务', () => {
  test('后一个模块的迁移失败：前一个模块的迁移也一起回滚', () => {
    const db = openDatabase(':memory:')
    runMigrations(db, [{ moduleId: 'b', migrations: [B1] }])
    expect(() =>
      runMigrations(db, [
        { moduleId: 'a', migrations: [A1, A2] },
        { moduleId: 'b', migrations: [B1, B2_BROKEN] },
      ]),
    ).toThrow()
    expect(tables(db)).toEqual(['b_one', 'kernel_migrations'])
    expect(planMigrations(db, [{ moduleId: 'a', migrations: [A1, A2] }]).pending).toEqual([
      { moduleId: 'a', from: 0, to: 2 },
    ])
    db.close()
  })
})

describe('backupDatabase', () => {
  test('VACUUM INTO 写出可独立打开的副本，只保留最近 keep 份', () => {
    const file = path.join(dir, 'p.db')
    const db = openDatabase(file)
    runMigrations(db, [{ moduleId: 'a', migrations: [A1] }])
    db.raw.exec("INSERT INTO a_one VALUES ('x')")
    const backups = path.join(dir, 'backups')
    let t = Date.UTC(2026, 0, 1)
    const made: string[] = []
    for (let i = 0; i < 4; i++) {
      made.push(backupDatabase(db, { dir: backups, label: 'v0.5.20', keep: 3, now: () => (t += 1000) }))
    }
    db.close()
    expect(listBackups(backups)).toEqual(made.slice(1))
    const copy = openDatabase(made[3] as string, { readonly: true })
    expect(copy.raw.query('SELECT id FROM a_one').all()).toEqual([{ id: 'x' }])
    copy.close()
  })
})

describe('只读打开', () => {
  test('能读，写入在 SQLite 层被拒绝', () => {
    const file = path.join(dir, 'p.db')
    const db = openDatabase(file)
    runMigrations(db, [{ moduleId: 'a', migrations: [A1] }])
    db.raw.exec("INSERT INTO a_one VALUES ('x')")
    db.close()
    const ro = openDatabase(file, { readonly: true })
    expect(ro.readonly).toBe(true)
    expect(ro.forModule('a').prepare('SELECT id FROM a_one').all()).toEqual([{ id: 'x' }])
    expect(() => ro.forModule('a').prepare("INSERT INTO a_one VALUES ('y')").run()).toThrow(
      /readonly|read-only|query_only/i,
    )
    ro.close()
  })
})

describe('purgeRetiredModules', () => {
  test('删掉退役模块的全部表与迁移记录，其它模块不动；内容不留在库文件里', () => {
    const file = path.join(dir, 'p.db')
    const db = openDatabase(file)
    runMigrations(db, [
      {
        moduleId: 'old-feature',
        migrations: [
          {
            version: 1,
            name: 'init',
            sql: 'CREATE TABLE old_feature_accounts (token TEXT); CREATE INDEX old_feature_accounts_by_token ON old_feature_accounts (token)',
          },
        ],
      },
      { moduleId: 'a', migrations: [A1] },
    ])
    db.raw.exec("INSERT INTO old_feature_accounts VALUES ('PLAINTEXT-SECRET-123')")
    expect(purgeRetiredModules(db, ['old-feature', 'never-existed'])).toEqual(['old-feature'])
    expect(tables(db)).toEqual(['a_one', 'kernel_migrations'])
    expect(db.raw.query('SELECT module FROM kernel_migrations').all()).toEqual([{ module: 'a' }])
    expect(purgeRetiredModules(db, ['old-feature'])).toEqual([])
    db.close()
    const bytes = readFileSync(file).toString('latin1')
    expect(bytes.includes('PLAINTEXT-SECRET-123')).toBe(false)
    if (existsSync(`${file}-wal`))
      expect(readFileSync(`${file}-wal`).toString('latin1').includes('PLAINTEXT-SECRET-123')).toBe(false)
  })
})
