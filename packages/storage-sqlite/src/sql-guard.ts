/** 模块 id → 表前缀：'agent-settings' → 'agent_settings' */
export function tablePrefix(moduleId: string): string {
  return moduleId.replace(/-/g, '_')
}

/** 去掉字符串字面量、带引号的标识符外的引号、注释，便于扫描关键字 */
function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
    .replace(/`([A-Za-z_][A-Za-z0-9_]*)`/g, '$1')
    .replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '$1')
}

const ID = '([A-Za-z_][A-Za-z0-9_]*)'
/** 每个模式的第 1 个捕获组是“对象名”（表、索引、触发器、视图、CTE 名） */
const PATTERNS: readonly RegExp[] = [
  new RegExp(`\\bFROM\\s+${ID}`, 'gi'),
  new RegExp(`\\bJOIN\\s+${ID}`, 'gi'),
  new RegExp(`\\bINTO\\s+${ID}`, 'gi'),
  new RegExp(`\\bUPDATE\\s+(?:OR\\s+[A-Za-z]+\\s+)?${ID}`, 'gi'),
  new RegExp(
    `\\b(?:CREATE|DROP|ALTER)\\s+(?:UNIQUE\\s+|TEMP\\s+|TEMPORARY\\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?${ID}`,
    'gi',
  ),
  new RegExp(`\\bON\\s+${ID}\\s*\\(`, 'gi'), // CREATE INDEX … ON t(…)
  new RegExp(`\\bREFERENCES\\s+${ID}`, 'gi'),
  new RegExp(`\\bRENAME\\s+TO\\s+${ID}`, 'gi'),
  new RegExp(`\\bWITH\\s+(?:RECURSIVE\\s+)?${ID}\\s+AS\\b`, 'gi'),
  new RegExp(`,\\s*${ID}\\s+AS\\s*\\(`, 'gi'), // 第二个及以后的 CTE
]
/** 允许出现在 FROM 后面的表值函数，以及会被模式误捕获的关键字（ON CONFLICT(…)、DO UPDATE SET …） */
const ALLOWED = new Set(['json_each', 'json_tree', 'conflict', 'set'])
const FORBIDDEN = /\b(ATTACH|DETACH|PRAGMA|VACUUM)\b/i

/** 返回 SQL 中引用的全部对象名（小写、去重）。只用于“前缀检查”，不是完整的 SQL 解析器 */
export function referencedTables(sql: string): string[] {
  const text = normalize(sql)
  const out = new Set<string>()
  for (const p of PATTERNS) {
    p.lastIndex = 0
    for (let m = p.exec(text); m !== null; m = p.exec(text)) {
      const name = m[1]!.toLowerCase()
      if (!ALLOWED.has(name)) out.add(name)
    }
  }
  return [...out]
}

export function assertOwnTables(sql: string, prefix: string, moduleId: string): void {
  if (FORBIDDEN.test(normalize(sql)))
    throw new Error(`[storage] 模块 ${moduleId} 不允许执行 ATTACH/DETACH/PRAGMA/VACUUM：${sql.slice(0, 120)}`)
  const own = `${prefix.toLowerCase()}_`
  const bad = referencedTables(sql).filter((t) => !t.startsWith(own))
  if (bad.length > 0) throw new Error(`[storage] 模块 ${moduleId} 只能访问 ${own}* 表，SQL 引用了：${bad.join(', ')}`)
}
