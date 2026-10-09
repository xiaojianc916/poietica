import { describe, expect, test } from 'bun:test'
import { assertOwnTables, referencedTables, tablePrefix } from '../sql-guard'

describe('tablePrefix', () => {
  test('kebab-case 模块 id → 下划线前缀', () => {
    expect(tablePrefix('agent-settings')).toBe('agent_settings')
    expect(tablePrefix('usage')).toBe('usage')
  })
})

// DB-3：referencedTables 只返回对象名
describe('referencedTables', () => {
  test('INSERT … ON CONFLICT(…) DO UPDATE SET …（只得到 a_x）', () => {
    expect(
      referencedTables('INSERT INTO a_x (id, n) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n'),
    ).toEqual(['a_x'])
  })

  test('CHECK (triggered_by IN (…)) 不产生对象名', () => {
    expect(
      referencedTables(
        "CREATE TABLE a_t (id TEXT PRIMARY KEY, triggered_by TEXT NOT NULL CHECK (triggered_by IN ('system', 'user')))",
      ),
    ).toEqual(['a_t'])
  })

  test('INSERT OR IGNORE INTO a_x', () => {
    expect(referencedTables('INSERT OR IGNORE INTO a_x (id) VALUES (?)')).toEqual(['a_x'])
  })

  test('UPDATE OR REPLACE a_y', () => {
    expect(referencedTables('UPDATE OR REPLACE a_y SET n = 1')).toEqual(['a_y'])
  })

  test('DELETE FROM a_z', () => {
    expect(referencedTables('DELETE FROM a_z WHERE id = ?')).toEqual(['a_z'])
  })

  test('CREATE INDEX IF NOT EXISTS a_i ON a_x(c)', () => {
    expect(referencedTables('CREATE INDEX IF NOT EXISTS a_i ON a_x(c)')).toEqual(['a_i', 'a_x'])
  })

  test('WITH a_c AS (…), a_d AS (…) SELECT … FROM a_c JOIN a_d', () => {
    expect(
      referencedTables(
        'WITH a_c AS (SELECT 1 AS id), a_d AS (SELECT 2 AS id) SELECT * FROM a_c JOIN a_d ON a_c.id = a_d.id',
      ),
    ).toEqual(['a_c', 'a_d'])
  })

  test('FROM json_each(?) 是表值函数，不算对象名', () => {
    expect(referencedTables('SELECT * FROM json_each(?)')).toEqual([])
  })

  test("字符串字面量 'select * from evil' 不算引用", () => {
    expect(referencedTables("SELECT * FROM a_x WHERE n = 'select * from evil'")).toEqual(['a_x'])
  })

  test('注释 -- from evil / /* from evil */ 不算引用', () => {
    expect(referencedTables('SELECT * FROM a_x -- from evil')).toEqual(['a_x'])
    expect(referencedTables('SELECT c FROM a_x /* from evil */')).toEqual(['a_x'])
  })

  test('结果小写并去重', () => {
    expect(referencedTables('SELECT * FROM A_X JOIN a_x ON A_X.id = a_x.id')).toEqual(['a_x'])
  })
})

describe('assertOwnTables', () => {
  test('本前缀的表通过（前缀比较忽略大小写）', () => {
    expect(() => assertOwnTables('SELECT * FROM agent_settings_x', 'agent_settings', 'agent-settings')).not.toThrow()
    expect(() => assertOwnTables('SELECT * FROM AGENT_SETTINGS_X', 'agent_settings', 'agent-settings')).not.toThrow()
  })

  test('别的模块的表抛错', () => {
    expect(() => assertOwnTables('SELECT * FROM conversation_threads', 'agent_settings', 'agent-settings')).toThrow(
      /只能访问 agent_settings_\* 表/,
    )
  })

  // DB-4：PRAGMA / ATTACH 被拒绝
  test('DB-4 PRAGMA 被拒绝', () => {
    expect(() => assertOwnTables('PRAGMA table_info(a_x)', 'a', 'a')).toThrow(
      /不允许执行 ATTACH\/DETACH\/PRAGMA\/VACUUM/,
    )
  })

  test('DB-4 ATTACH 被拒绝', () => {
    expect(() => assertOwnTables('ATTACH DATABASE ? AS extra', 'a', 'a')).toThrow(
      /不允许执行 ATTACH\/DETACH\/PRAGMA\/VACUUM/,
    )
  })
})
