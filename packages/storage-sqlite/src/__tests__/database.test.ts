import { Database as BunDatabase } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../database'

const tempDirs: string[] = []

function newTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'storage-sqlite-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  // 注意：先 close() 再删目录，否则 Windows 上 -wal / -shm 被占用
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('openDatabase', () => {
  // DB-1：WAL 对 :memory: 无效，因此用临时目录里的文件库
  test('DB-1 文件库的 PRAGMA 设置', () => {
    const db = openDatabase(path.join(newTempDir(), 'test.db'))
    try {
      expect(db.raw.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(db.raw.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      // 注意：SQLite 把 `PRAGMA busy_timeout` 的列名报成 `timeout`，所以断言取值而不是列名
      expect(db.raw.query('PRAGMA busy_timeout').values()).toEqual([[5000]])
      // 长连接维护（数据库性能方案 D4）：-wal 检查点后截回 64 MiB；optimize 每张表最多抽 400 行
      expect(db.raw.query('PRAGMA journal_size_limit').values()).toEqual([[67108864]])
      expect(db.raw.query('PRAGMA analysis_limit').values()).toEqual([[400]])
    } finally {
      db.close()
    }
  })

  test('DB-2 本模块前缀的表通过、别的模块的表抛错', () => {
    const db = openDatabase(':memory:')
    try {
      const mdb = db.forModule('agent-settings')
      expect(mdb.moduleId).toBe('agent-settings')
      expect(mdb.prefix).toBe('agent_settings')
      expect(db.forModule('agent-settings')).toBe(mdb)
      mdb.exec('CREATE TABLE agent_settings_x (id TEXT PRIMARY KEY, n INTEGER NOT NULL)')
      mdb.prepare('INSERT INTO agent_settings_x (id, n) VALUES (?, ?)').run('a', 1)
      expect(mdb.prepare('SELECT * FROM agent_settings_x').all()).toEqual([{ id: 'a', n: 1 }])
      expect(() => mdb.prepare('SELECT * FROM conversation_threads')).toThrow(/只能访问 agent_settings_\* 表/)
      expect(() => mdb.exec('SELECT * FROM conversation_threads')).toThrow(/只能访问 agent_settings_\* 表/)
    } finally {
      db.close()
    }
  })

  // DB-4：PRAGMA / ATTACH 无论引用哪张表都被拒绝
  test('DB-4 PRAGMA、ATTACH 被拒绝', () => {
    const db = openDatabase(':memory:')
    try {
      const mdb = db.forModule('agent-settings')
      expect(() => mdb.exec('PRAGMA table_info(agent_settings_x)')).toThrow(/不允许执行 ATTACH\/DETACH\/PRAGMA\/VACUUM/)
      expect(() => mdb.prepare('ATTACH DATABASE ? AS extra')).toThrow(/不允许执行 ATTACH\/DETACH\/PRAGMA\/VACUUM/)
      // 内核用的 raw 不做前缀检查
      expect(db.raw.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    } finally {
      db.close()
    }
  })

  // DB-5：关库前跑 optimize，规划器的统计（sqlite_stat1）落进库里，下次开库直接可用
  test('DB-5 关库时刷新查询统计', () => {
    const file = path.join(newTempDir(), 'stat.db')
    const db = openDatabase(file)
    const mdb = db.forModule('agent-settings')
    mdb.exec('CREATE TABLE agent_settings_x (id TEXT PRIMARY KEY, k TEXT NOT NULL)')
    mdb.exec('CREATE INDEX agent_settings_x_by_k ON agent_settings_x (k)')
    mdb.transaction(() => {
      for (let i = 0; i < 200; i++)
        mdb.prepare('INSERT INTO agent_settings_x (id, k) VALUES (?, ?)').run(`id${i}`, `k${i % 5}`)
    })
    expect(mdb.prepare('SELECT id FROM agent_settings_x WHERE k = ?').all('k1')).toHaveLength(40)
    db.close()

    /* 用裸连接读：openDatabase 开库时自己也会补统计，那样就分不出是不是关库那一次写的 */
    const plain = new BunDatabase(file, { readonly: true })
    try {
      expect(plain.query("SELECT tbl FROM sqlite_stat1 WHERE tbl = 'agent_settings_x'").all().length).toBeGreaterThan(0)
    } finally {
      plain.close()
    }
  })

  test('事务提交与回滚', () => {
    const db = openDatabase(':memory:')
    try {
      const mdb = db.forModule('usage')
      mdb.exec('CREATE TABLE usage_x (id TEXT PRIMARY KEY)')
      mdb.transaction(() => {
        mdb.prepare('INSERT INTO usage_x (id) VALUES (?)').run('kept')
      })
      expect(() => {
        mdb.transaction(() => {
          mdb.prepare('INSERT INTO usage_x (id) VALUES (?)').run('rolled-back')
          throw new Error('boom')
        })
      }).toThrow('boom')
      expect(mdb.prepare('SELECT id FROM usage_x').all()).toEqual([{ id: 'kept' }])
    } finally {
      db.close()
    }
  })
})
