/**
 * 编辑器工程映射的闸门：每个测试文件都要有一个「往上找得到、且包含它」的 tsconfig 工程，
 * 且该工程解析后的 types 里有 "bun"。
 *
 * 背景（refactor-log 偏差 #17 与 2026-10-09 那条）：tooling/tsconfig/base.json 一律 exclude 测试文件
 * （测试的规则更松，也不进 tsc -b），于是测试文件不属于任何 project —— VS Code / Trae 按
 * 「最近的、且包含它的 tsconfig」往上找，找不到就回落到没有类型定义的推断工程：
 * 第一行 import { … } from 'bun:test' 报 TS2307、Bun 报 TS2868。仓库自己的 bun run check
 * （tsc -p tsconfig.tests.json）一直是绿的，红的是编辑器。
 *
 * 判据（两种写法，看工程与容器目录是否同名）：
 *   • 容器目录（packages/、features/、apps/）放一个 extends 根 tsconfig.tests.json 的
 *     tsconfig.json，include 只收测试 glob；
 *   • 工程自己就在容器目录（tooling/、scripts/）：在自己的 tsconfig.json 里覆盖 exclude，
 *     只排产物目录，把测试留在工程里。
 *
 * 用法：bun run tooling/checks/editor-project-map.ts（由 bun run lint 调用）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
/** 产物目录按名字跳过；tooling/release 是源码目录（不是打包产物），单列出来。 */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.tsbuild',
  'dist',
  'dist-release',
  'dist-probe',
  'out',
  'release',
  'coverage',
])
const SOURCE_DIRS = new Set(['tooling/release'])
const TEST_FILE = /(^|\/)(__tests__\/|[^/]+\.test\.tsx?$)/
/** 测试跑在 bun 上：覆盖它的工程必须看得见 bun:test 与 Bun。 */
const REQUIRED_TYPE = 'bun'
const CONFIG_DIR = '$' + '{configDir}/'

interface TsConfig {
  extends?: string
  include?: string[] | undefined
  exclude?: string[] | undefined
  files?: string[] | undefined
  compilerOptions?: { types?: string[] | undefined } | undefined
}

const posix = (p: string): string => p.split(path.sep).join('/')
const readJson = (file: string): TsConfig => JSON.parse(readFileSync(file, 'utf8')) as TsConfig

/** extends 链合并：子配置覆盖父配置（本仓库只有单链 extends，没有数组形式） */
function resolveConfig(file: string, seen = new Set<string>()): TsConfig {
  const cfg = readJson(file)
  if (cfg.extends === undefined || seen.has(file)) return cfg
  seen.add(file)
  const base = cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`
  const parentFile = path.resolve(path.dirname(file), base)
  const parent = existsSync(parentFile) ? resolveConfig(parentFile, seen) : {}
  return {
    include: cfg.include ?? parent.include,
    exclude: cfg.exclude ?? parent.exclude,
    files: cfg.files ?? parent.files,
    compilerOptions: { types: cfg.compilerOptions?.types ?? parent.compilerOptions?.types },
  }
}

/** include / exclude 条目：含通配符的走 Bun.Glob，纯目录（"src"）按前缀匹配 */
function matches(patterns: readonly string[], rel: string): boolean {
  return patterns.some((raw) => {
    const pattern = raw.split(CONFIG_DIR).join('').replace(/^\.\//, '').replace(/\/+$/, '')
    if (pattern === '' || pattern === '.') return true
    if (!/[*?{[]/.test(pattern)) return rel === pattern || rel.startsWith(`${pattern}/`)
    return new Bun.Glob(pattern).match(rel)
  })
}

const cache = new Map<string, TsConfig>()
function configOf(file: string): TsConfig {
  const hit = cache.get(file)
  if (hit !== undefined) return hit
  const cfg = resolveConfig(file)
  cache.set(file, cfg)
  return cfg
}

/** 从文件所在目录往上找：第一个「包含它、且没把它排除掉」的 tsconfig.json 就是编辑器认的工程 */
function coveringProject(file: string): { config: string; types: string[] } | null {
  let dir = path.dirname(file)
  for (;;) {
    const configFile = path.join(dir, 'tsconfig.json')
    if (existsSync(configFile)) {
      const cfg = configOf(configFile)
      const rel = posix(path.relative(dir, file))
      const included = matches(cfg.files ?? [], rel) || matches(cfg.include ?? [], rel)
      if (included && !matches(cfg.exclude ?? [], rel)) {
        return { config: posix(path.relative(ROOT, configFile)), types: cfg.compilerOptions?.types ?? [] }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir || dir === ROOT) break
    dir = parent
  }
  return null
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = path.join(dir, entry.name)
      const rel = posix(path.relative(ROOT, child))
      if (entry.name.startsWith('.') || (SKIP_DIR_NAMES.has(entry.name) && !SOURCE_DIRS.has(rel))) continue
      collect(child, out)
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      const file = path.join(dir, entry.name)
      if (TEST_FILE.test(posix(path.relative(ROOT, file)))) out.push(file)
    }
  }
  return out
}

const files = collect(ROOT).sort()
const failures: string[] = []
for (const file of files) {
  const rel = posix(path.relative(ROOT, file))
  const project = coveringProject(file)
  if (project === null) failures.push(`${rel}  ← 没有任何包含它的 tsconfig 工程（编辑器会回落到推断工程）`)
  else if (!project.types.includes(REQUIRED_TYPE))
    failures.push(`${rel}  ← 工程 ${project.config} 的 types 里没有 "${REQUIRED_TYPE}"`)
}

if (failures.length > 0) {
  console.error('以下测试文件在编辑器里会报 TS2307（bun:test）/ TS2868（Bun）：')
  for (const line of failures) console.error(`  ${line}`)
  console.error('')
  console.error(`共 ${failures.length} 个文件。修法（照已有的样子）：`)
  console.error(
    '  • 容器目录（packages/、features/、apps/）加 tsconfig.json：extends 根 tsconfig.tests.json，include 只收测试 glob；',
  )
  console.error(
    '  • 工程与容器同名（tooling/、scripts/ 这种）则在自己的 tsconfig.json 里覆盖 exclude，只排产物目录，把测试留在工程里。',
  )
  process.exit(1)
}

console.log(`✔ 测试文件的编辑器工程映射完整（检查 ${files.length} 个文件）`)
