/**
 * 铁律 5 的闸门：`features/**` 里不许再出现裸 `Error`。
 *
 * 三类判定（09 页 §4 第 5 条，产品负责人 2026-10-07 定的口径）：
 *   A 业务错误   —— 会跨 RPC 边界或被用户看到 → `AppError` + 本功能 `defineErrors` 的错误码
 *   B 程序不变量 —— 代码写对了就不该发生 → `invariant()` / `assertNever()`
 *   C 表单校验   —— 用户输入不合法 → 返回值（`{ ok: false, message }`），不抛异常
 *
 * 三类之外没有第四类，所以这一层里任何 `new Error(...)` / `throw '...'` 都是漏网。
 * 唯一豁免是 foundation 里 `invariant` 的实现本身 —— 它不在本脚本的扫描范围内。
 *
 * 用法：`bun run tooling/checks/no-raw-errors.ts`（由 `bun run lint` 调用）
 */
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const SKIP_DIRS = new Set(['node_modules', '.tsbuild', 'dist', 'out', 'release', 'vendor'])

/** 测试文件可以拿裸 Error 当夹具（「让它炸」正是被测行为），与 depcruise 的 TEST 豁免同一判据。 */
const TEST_FILE = /(^|\/)(__tests__\/|[^/]+\.test\.tsx?$)/

/** 一条命中：B 类与 A 类都不该出现在这里。 */
const PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'new Error(', re: /\bnew\s+Error\s*\(/ },
  { name: 'new AggregateError(', re: /\bnew\s+AggregateError\s*\(/ },
  { name: 'throw 内置错误类', re: /\bthrow\s+new\s+(?:TypeError|RangeError|SyntaxError|URIError)\s*\(/ },
  { name: 'throw \'...\' / throw "..."', re: /\bthrow\s+(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/ },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: dir, onlyFiles: true })) {
    const rel = entry.replace(/\\/g, '/')
    if (rel.split('/').some((part) => SKIP_DIRS.has(part))) continue
    if (TEST_FILE.test(rel)) continue
    out.push(path.join(dir, entry))
  }
  return out
}

const files = walk(path.join(ROOT, 'features'))
const hits: string[] = []

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const lines = (await Bun.file(file).text()).split('\n')
  for (const [index, line] of lines.entries()) {
    // 注释里出现这些字样不算命中（说明文字经常引用它们）
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const { name, re } of PATTERNS) {
      if (re.test(code)) hits.push(`${rel}:${index + 1}  ${name}  → ${line.trim()}`)
    }
  }
}

if (hits.length > 0) {
  console.error('features/** 里出现了裸 Error（应按 A / B / C 三类改写）：')
  for (const hit of hits) console.error(`  ${hit}`)
  console.error(`\n共 ${hits.length} 处。A → AppError + 错误码；B → invariant()；C → 返回值。`)
  process.exit(1)
}

console.log(`✔ features/** 无裸 Error（检查 ${files.length} 个文件）`)
