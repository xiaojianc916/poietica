import { describe, expect, test } from 'bun:test'
import { openDatabase, runMigrations } from '@poietica/storage-sqlite'
import { migrations } from '../migrations'

/*
 * 「临时会话 / 不在项目中工作」删除后的一次性数据迁移：
 * 存量 scratch 行一条不删（底下可能挂着真实对话），只把名字换成中性项目名；
 * kind 列随之消失，工作区只剩一种。
 */
describe('workspaces 迁移 v2', () => {
  test('scratch 行改名为「项目 <短号>」、folder 行名字不动，kind 列消失', () => {
    const db = openDatabase(':memory:')
    try {
      /* 只跑 v1：造出带 kind 的旧表与两行旧数据 */
      runMigrations(db, [{ moduleId: 'workspaces', migrations: [migrations[0]!] }])
      const v1 = db.forModule('workspaces')
      v1.prepare(
        `INSERT INTO workspaces_workspaces (id, kind, path, path_key, name, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        '01M59QBXPGWVMSE9YSSN3CZC0B',
        'scratch',
        'C:/data/scratch/01M59QBXPGWVMSE9YSSN3CZC0B',
        'c:/data/scratch/01m59qbxpgwvmse9yssn3czc0b',
        '临时对话',
        1,
        1,
      )
      v1.prepare(
        `INSERT INTO workspaces_workspaces (id, kind, path, path_key, name, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('01M481R6Z4PDAV98QZXAAQ3CMN', 'folder', 'D:/xiaojianc/poietica', 'd:/xiaojianc/poietica', 'poietica', 2, 2)

      runMigrations(db, [{ moduleId: 'workspaces', migrations }])

      const rows = v1
        .prepare<{ id: string; name: string }>('SELECT id, name FROM workspaces_workspaces ORDER BY id')
        .all()
      expect(rows).toEqual([
        { id: '01M481R6Z4PDAV98QZXAAQ3CMN', name: 'poietica' },
        { id: '01M59QBXPGWVMSE9YSSN3CZC0B', name: '项目 3CZC0B' },
      ])

      const columns = db.raw.query('PRAGMA table_info(workspaces_workspaces)').all() as { name: string }[]
      expect(columns.map((column) => column.name)).not.toContain('kind')
    } finally {
      db.close()
    }
  })
})
