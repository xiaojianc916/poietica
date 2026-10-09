/**
 * 铁律 3 的闸门：全仓不许出现 `抑制注释`。
 *
 * 规则例外只能写在 biome.json 的 overrides 里，按精确文件路径列出，并在文件头注释说明原因
 * （见 docs/refactor-log.md「规则例外」一节与 10 页 P0.7）。这样例外集中在一处，审查时一眼能看全。
 *
 * 用法：`bun run tooling/checks/no-抑制注释.ts`（由 `bun run lint` 调用）
 */
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const SELF = 'tooling/checks/no-抑制注释.ts'
const NEEDLE = 'biome' + '-ignore'
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.bun-cache',
  '.tsbuild',
  '.probe-home',
  'dist',
  'out',
  'release',
  'coverage',
  'vendor',
  'docs',
  'Project Refactoring Plan',
])

const files: string[] = []
for (const entry of new Bun.Glob('**/*.{ts,tsx,js,jsx,mjs,cjs}').scanSync({ cwd: ROOT, onlyFiles: true })) {
  const rel = entry.replace(/\\/g, '/')
  if (rel === SELF) continue
  if (rel.split('/').some((part: string) => SKIP_DIRS.has(part))) continue
  files.push(path.join(ROOT, entry))
}

const hits: string[] = []
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const lines = (await Bun.file(file).text()).split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.includes(NEEDLE)) hits.push(`${rel}:${index + 1}  ${line.trim()}`)
  }
}

if (hits.length > 0) {
  console.error(`发现了 ${hits.length} 处 ${NEEDLE}（规则例外请写进 biome.json 的 overrides）：`)
  for (const hit of hits) console.error(`  ${hit}`)
  process.exit(1)
}
console.log(`✔ 全仓无 ${NEEDLE}（检查 ${files.length} 个文件）`)
