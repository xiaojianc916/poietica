import { describe, expect, test } from 'bun:test'
import { assertOwnTables, tablePrefix } from '../sql-guard'

describe('tablePrefix', () => {
  test('kebab-case 模块 id → 下划线前缀', () => {
    expect(tablePrefix('agent-settings')).toBe('agent_settings')
    expect(tablePrefix('usage')).toBe('usage')
  })
})

describe('assertOwnTables', () => {
  /* DB-3：对象名扫描的边角（原来直接钉 referencedTables；它降为模块内私有之后，
   * 这些输入改从公开入口断言 —— 判据一样，越界的那些必须被拒）。 */
  test('ON CONFLICT / OR IGNORE / OR REPLACE / CTE / 表值函数 / 字面量与注释里的假引用', () => {
    const passes = [
      'INSERT INTO a_x (id, n) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n',
      'INSERT OR IGNORE INTO a_x (id) VALUES (?)',
      'UPDATE OR REPLACE a_x SET n = 1',
      'DELETE FROM a_x WHERE id = ?',
      'CREATE INDEX IF NOT EXISTS a_i ON a_x(c)',
      'WITH a_c AS (SELECT 1 AS id) SELECT * FROM a_c',
      'SELECT * FROM json_each(?)',
      "SELECT * FROM a_x WHERE n = 'select * from evil'",
      'SELECT * FROM a_x -- from evil',
      'SELECT c FROM a_x /* from evil */',
      'SELECT * FROM A_X JOIN a_x ON A_X.id = a_x.id',
    ]
    for (const sql of passes) {
      expect(() => assertOwnTables(sql, 'a', 'a')).not.toThrow()
    }
    /* CHECK (triggered_by IN (…)) 不产生第二个对象名：只认 a_t，不该因 'system'/'user' 之类的词误判 */
    expect(() =>
      assertOwnTables(
        "CREATE TABLE a_t (id TEXT PRIMARY KEY, triggered_by TEXT NOT NULL CHECK (triggered_by IN ('system', 'user')))",
        'a',
        'a',
      ),
    ).not.toThrow()
    /* 反向：这些输入里的表**必须**被抓到（否则前缀闸门形同虚设） */
    for (const sql of [
      'INSERT OR IGNORE INTO b_x (id) VALUES (?)',
      'UPDATE OR REPLACE b_x SET n = 1',
      'WITH b_c AS (SELECT 1 AS id) SELECT * FROM b_c',
      'CREATE INDEX IF NOT EXISTS b_i ON a_x(c)',
    ]) {
      expect(() => assertOwnTables(sql, 'a', 'a')).toThrow(/只能访问 a_\* 表/)
    }
  })

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
