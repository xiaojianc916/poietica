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
    } finally {
      db.close()
    }
  })

  // DB-2：模块视图只允许访问本模块前缀的表
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
