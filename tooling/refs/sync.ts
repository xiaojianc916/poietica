// 用法：bun run refs          写入最新的 references
//      bun run refs --check  只检查，不一致时列出并以退出码 1 结束（check 脚本使用）
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const PROJECT_PATTERNS = [
  'tooling/tsconfig.json',
  'scripts/tsconfig.json',
  'packages/*/tsconfig.json',
  'features/*/src/*/tsconfig.json',
  'apps/core/tsconfig.json',
  'apps/desktop/tsconfig.json',
  'apps/desktop/src/*/tsconfig.json',
  'apps/desktop/scripts/tsconfig.json',
]
const SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const TEST_FILE = /(^|\/)(__tests__\/|[^/]+\.test\.tsx?$)/
const SKIP_DIRS = new Set(['node_modules', '.tsbuild', 'dist', 'out', 'release'])

const posix = (p: string) => p.split(path.sep).join('/')

export function listProjects(root: string): string[] {
  const out = new Set<string>()
  for (const pattern of PROJECT_PATTERNS) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true }))
      out.add(posix(path.dirname(file)))
  }
  return [...out].sort()
}

interface TsConfig {
  include?: string[]
  files?: string[]
  references?: Array<{ path: string }>
  [k: string]: unknown
}
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T

function walk(dir: string, nestedProjects: ReadonlySet<string>, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) {
      if (SKIP_DIRS.has(name) || nestedProjects.has(posix(path.relative(root, abs)))) continue
      walk(abs, nestedProjects, root, out)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(abs)
    }
  }
}

export function sourceFiles(root: string, project: string, projects: readonly string[]): string[] {
  const dir = path.join(root, project)
  const cfg = readJson<TsConfig>(path.join(dir, 'tsconfig.json'))
  const nested = new Set(projects.filter((p) => p !== project && p.startsWith(`${project}/`)))
  const files: string[] = []
  for (const entry of cfg.include ?? []) {
    const abs = path.join(dir, entry)
    if (/[*?{]/.test(entry)) {
      for (const f of new Bun.Glob(entry).scanSync({ cwd: dir, onlyFiles: true })) files.push(path.join(dir, f))
    } else if (existsSync(abs) && statSync(abs).isDirectory()) {
      walk(abs, nested, root, files)
    } else if (existsSync(abs)) {
      files.push(abs)
    }
  }
  for (const f of cfg.files ?? []) files.push(path.join(dir, f))
  return [...new Set(files)].filter((f) => !TEST_FILE.test(posix(path.relative(dir, f)))).sort()
}

function resolveFile(base: string): string | null {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function resolveSpecifier(root: string, fromFile: string, spec: string): string | null {
  if (spec.startsWith('.')) return resolveFile(path.resolve(path.dirname(fromFile), spec))
  const m = /^@poietica\/([^/]+)(?:\/(.+))?$/.exec(spec)
  if (m === null) return null
  const [, name, sub] = m as unknown as [string, string, string | undefined]
  const pkgDir = name.startsWith('feature-')
    ? path.join(root, 'features', name.slice('feature-'.length))
    : path.join(root, 'packages', name)
  const pkgFile = path.join(pkgDir, 'package.json')
  if (!existsSync(pkgFile)) return null
  const exportsMap = readJson<{ exports?: Record<string, string | Record<string, string>> }>(pkgFile).exports ?? {}
  const target = exportsMap[sub === undefined ? '.' : `./${sub}`]
  const rel = typeof target === 'string' ? target : (target?.default ?? target?.import)
  return rel === undefined ? null : resolveFile(path.join(pkgDir, rel))
}

function owningProject(root: string, file: string, projects: ReadonlySet<string>): string | null {
  let dir = posix(path.relative(root, path.dirname(file)))
  while (dir !== '' && dir !== '.') {
    if (projects.has(dir)) return dir
    const parent = path.posix.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 计算每个项目应有的 references（键：项目目录；值：相对路径数组，已排序） */
export function computeReferences(root: string): Map<string, string[]> {
  const projects = listProjects(root)
  const projectSet = new Set(projects)
  const result = new Map<string, string[]>()
  for (const project of projects) {
    const refs = new Set<string>()
    for (const file of sourceFiles(root, project, projects)) {
      const text = readFileSync(file, 'utf8')
      SPECIFIER.lastIndex = 0
      for (let m = SPECIFIER.exec(text); m !== null; m = SPECIFIER.exec(text)) {
        const spec = m[1] ?? m[2]
        if (spec === undefined) continue
        const target = resolveSpecifier(root, file, spec)
        if (target === null) continue
        const owner = owningProject(root, target, projectSet)
        if (owner !== null && owner !== project) refs.add(path.posix.relative(project, owner))
      }
    }
    result.set(project, [...refs].sort())
  }
  return result
}

const isPrimitive = (v: unknown) => v === null || typeof v !== 'object'

/** 与 biome 的 JSON 格式化保持一致：只含标量的数组写在一行（references 是对象数组，仍逐项展开） */
function stringify(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 2)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every(isPrimitive)) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
    return `[\n${value.map((item) => `${inner}${stringify(item, indent + 2)}`).join(',\n')}\n${pad}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    const body = entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringify(v, indent + 2)}`).join(',\n')
    return `{\n${body}\n${pad}}`
  }
  return JSON.stringify(value)
}

const format = (v: unknown) => `${stringify(v, 0)}\n`

/** 返回需要改动的文件（相对路径 → 新内容）。不写盘 */
export function planSync(root: string): Map<string, string> {
  const changes = new Map<string, string>()
  const refs = computeReferences(root)
  for (const [project, list] of refs) {
    const file = path.join(root, project, 'tsconfig.json')
    const cfg = readJson<TsConfig>(file)
    const next = format({ ...cfg, references: list.map((p) => ({ path: p })) })
    if (readFileSync(file, 'utf8') !== next) changes.set(posix(path.relative(root, file)), next)
  }
  const rootFile = path.join(root, 'tsconfig.json')
  const rootNext = format({ files: [], references: [...refs.keys()].map((p) => ({ path: p })) })
  if (readFileSync(rootFile, 'utf8') !== rootNext) changes.set('tsconfig.json', rootNext)
  return changes
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '../..')
  const check = process.argv.includes('--check')
  const changes = planSync(root)
  if (check) {
    if (changes.size > 0) {
      console.error(
        `以下 tsconfig 的 references 不是最新的，请运行 bun run refs：\n${[...changes.keys()].map((f) => `  ${f}`).join('\n')}`,
      )
      process.exit(1)
    }
  } else {
    for (const [file, content] of changes) {
      JSON.parse(content) // 写盘前自检：格式坏了也要先炸，绝不把坏内容写进 tsconfig
      writeFileSync(path.join(root, file), content)
    }
    console.log(changes.size === 0 ? 'references 已是最新' : `已更新 ${changes.size} 个文件`)
  }
}
