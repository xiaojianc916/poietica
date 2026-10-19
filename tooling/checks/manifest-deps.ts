/**
 * 依赖清单如实的闸门：package.json 声明的工作区依赖（@poietica/*）必须与源码对得上。
 *
 * depcruise 的 `not-to-undeclared` 只管一个方向——「用了没声明」。反方向没人管：
 * 声明了却没用、只在测试里用却写进 dependencies。这些多出来的边不影响构建，却让依赖清单
 * （评审读的、`bun run refs` 与 depcruise 之外最直观的分层图）比真实图更耦合，
 * 审查分层时会被误判；删掉某条真实依赖后清单也不会提醒。本检查补上反方向：
 *
 *   1. dependencies / peerDependencies 里的包，产品代码（非测试文件）必须用到；
 *      只有测试用到的应放 devDependencies。
 *   2. devDependencies 里的工作区包，必须至少被某个文件用到。
 *
 * 「用到」= import / export from / 动态 import / require 的说明符，或 `/// <reference path>`
 * 指向该包目录下的文件。测试文件的判定与 depcruise 的 TEST 一致：__tests__/ 目录或 *.test.ts(x)。
 * 只看工作区包：外部包常经 CSS、类型、构建插件间接使用，静态扫描判不准。
 * 不经 import 的真实依赖（构建产物依赖）登记在 ARTIFACT，附理由。
 *
 * 用法：`bun run tooling/checks/manifest-deps.ts`（由 `bun run lint` 调用）
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const MANIFESTS = ['packages/*/package.json', 'features/*/package.json', 'apps/*/package.json']
const SKIP_DIRS = new Set(['node_modules', '.tsbuild', 'dist', 'out', 'release', 'coverage'])
const TEST = /(\/__tests__\/|\.test\.tsx?$)/
const SOURCE = '**/*.{ts,tsx,mts,cts,js,mjs,cjs,css}'
const SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"](@poietica\/[^'"/]+)[^'"]*['"]|(?:import|require)\s*\(\s*['"](@poietica\/[^'"/]+)[^'"]*['"]\s*\)|@import\s+['"](@poietica\/[^'"/]+)[^'"]*['"]/g
/** 不经 import、依赖的是对方构建产物的边：`包目录 → 依赖名 → 理由` */
const ARTIFACT: Record<string, Record<string, string>> = {
  'apps/desktop': {
    '@poietica/app-core':
      '安装包带上 apps/core 的构建产物（electron-builder.yml 的 extraResources），并让 --filter 按拓扑序先构建 Core',
  },
}
const REFERENCE = /^\/\/\/\s*<reference\s+path=["']([^"']+)["']/gm

interface Manifest {
  readonly name: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

const posix = (p: string) => p.split(path.sep).join('/')
const workspace = (deps: Record<string, string> | undefined) =>
  Object.keys(deps ?? {}).filter((d) => d.startsWith('@poietica/'))

const packages = new Map<string, { dir: string; manifest: Manifest }>()
for (const pattern of MANIFESTS) {
  for (const file of new Bun.Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })) {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as Manifest
    packages.set(manifest.name, { dir: posix(path.dirname(file)), manifest })
  }
}
/** 目录 → 包名：`/// <reference path>` 指到哪个包的目录下，就算用到哪个包 */
const byDir = [...packages].map(([name, p]) => [`${p.dir}/`, name] as const)

const problems: string[] = []
for (const [name, { dir, manifest }] of packages) {
  const prod = new Set<string>()
  const test = new Set<string>()
  for (const entry of new Bun.Glob(SOURCE).scanSync({ cwd: path.join(ROOT, dir), onlyFiles: true })) {
    const rel = posix(entry)
    if (rel.split('/').some((part) => SKIP_DIRS.has(part))) continue
    const used = TEST.test(`/${rel}`) ? test : prod
    const text = readFileSync(path.join(ROOT, dir, rel), 'utf8')
    for (const m of text.matchAll(SPECIFIER)) used.add((m[1] ?? m[2] ?? m[3]) as string)
    for (const m of text.matchAll(REFERENCE)) {
      const target = posix(path.relative(ROOT, path.resolve(ROOT, dir, path.dirname(rel), m[1] as string)))
      const owner = byDir.find(([d]) => target.startsWith(d))?.[1]
      if (owner !== undefined) used.add(owner)
    }
  }
  prod.delete(name)
  test.delete(name)
  for (const dep of Object.keys(ARTIFACT[dir] ?? {})) prod.add(dep)
  for (const dep of [...workspace(manifest.dependencies), ...workspace(manifest.peerDependencies)]) {
    if (prod.has(dep)) continue
    problems.push(
      test.has(dep)
        ? `${dir}: ${dep} 只有测试用到，应移到 devDependencies`
        : `${dir}: ${dep} 声明在 dependencies 里，但没有任何文件用到`,
    )
  }
  for (const dep of workspace(manifest.devDependencies)) {
    if (!prod.has(dep) && !test.has(dep)) problems.push(`${dir}: ${dep} 声明在 devDependencies 里，但没有任何文件用到`)
  }
}

if (problems.length > 0) {
  console.error(`依赖清单与源码不一致（${problems.length} 处）：`)
  for (const p of problems.sort()) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`✔ 依赖清单如实（检查 ${packages.size} 个包的工作区依赖）`)
