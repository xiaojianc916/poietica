/**
 * 装配清单的闸门：`features/` 目录事实 ↔ 三个进程的模块清单 ↔ protocol 的契约汇总。
 *
 * 背景：新增功能 = 增删目录 + 三份清单各一行，但三份清单此前没有任何静态检查。漏一行的后果是
 * 功能的全套代码、测试、typecheck、depcruise 全绿，只是**永远不被装配**；contract 漏登记则要等
 * Core 真实启动才在 kernel.ts 里抛错（createCoreHarness 用模块自带的契约自组，看不到 protocol）。
 * 这份检查把两类漏配提前到 `bun run lint`。
 *
 * 只读文本，不 import apps/*：tooling 不认识应用装配，也不该为了检查而建立这条依赖。
 *
 * 用法：`bun run tooling/checks/manifest-coverage.ts`（由 `bun run lint` 调用）
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const FEATURES = path.join(ROOT, 'features')
const PROTOCOL = path.join(ROOT, 'packages/protocol/src/index.ts')

interface Entrypoint {
  readonly sub: 'core' | 'host' | 'ui' | 'contract'
  readonly manifest: string
}

const ENTRYPOINTS: readonly Entrypoint[] = [
  { sub: 'core', manifest: 'apps/core/src/modules.ts' },
  { sub: 'host', manifest: 'apps/desktop/src/main/modules.ts' },
  { sub: 'ui', manifest: 'apps/desktop/src/renderer/features.ts' },
]

const indexOf = (featureDir: string, sub: string): string | null => {
  for (const ext of ['ts', 'tsx']) {
    const file = path.join(featureDir, 'src', sub, `index.${ext}`)
    if (existsSync(file)) return file
  }
  return null
}

const importedFeatures = (file: string, sub: string): Set<string> => {
  const text = readFileSync(file, 'utf8')
  const pattern = new RegExp(`from\\s+['"]@poietica/feature-([^/'"]+)/${sub}['"]`, 'g')
  return new Set([...text.matchAll(pattern)].map((m) => m[1] as string))
}

const features = [...new Bun.Glob('*/package.json').scanSync({ cwd: FEATURES, onlyFiles: true })]
  .map((file) => path.dirname(file))
  .sort()

const problems: string[] = []

for (const feature of features) {
  const dir = path.join(FEATURES, feature)
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    exports?: Record<string, string>
  }
  for (const sub of ['contract', 'core', 'core-api', 'host', 'ui', 'ui-api'] as const) {
    const hasDir = indexOf(dir, sub) !== null
    const hasExport = manifest.exports?.[`./${sub}`] !== undefined
    if (hasDir && !hasExport)
      problems.push(`features/${feature}: 有 src/${sub}/index，但 package.json exports 没有 ./${sub}`)
    if (hasExport && !hasDir) problems.push(`features/${feature}: exports 声明了 ./${sub}，但 src/${sub}/index 不存在`)
  }
}

for (const { sub, manifest } of ENTRYPOINTS) {
  const manifestFile = path.join(ROOT, manifest)
  if (!existsSync(manifestFile)) {
    problems.push(`${manifest}: 清单文件不存在`)
    continue
  }
  const listed = importedFeatures(manifestFile, sub)
  const present = new Set(features.filter((feature) => indexOf(path.join(FEATURES, feature), sub) !== null))

  for (const feature of present) {
    if (!listed.has(feature)) problems.push(`features/${feature}: 有 src/${sub}，但没有装进 ${manifest}`)
  }
  for (const feature of listed) {
    if (!present.has(feature)) {
      problems.push(`${manifest}: 装配了 @poietica/feature-${feature}/${sub}，但 features/${feature}/src/${sub} 不存在`)
    }
  }
}

/* protocol 汇总全部功能的 contract：漏登记时 Core 启动才抛 moduleGraphInvalid。 */
const registered = importedFeatures(PROTOCOL, 'contract')
const contractFeatures = new Set(
  features.filter((feature) => indexOf(path.join(FEATURES, feature), 'contract') !== null),
)
for (const feature of contractFeatures) {
  if (!registered.has(feature))
    problems.push(`features/${feature}: 有 contract，但没有登记进 packages/protocol/src/index.ts`)
}
for (const feature of registered) {
  if (!contractFeatures.has(feature)) {
    problems.push(`packages/protocol: 登记了 @poietica/feature-${feature}/contract，但该功能的 contract 入口不存在`)
  }
}

if (problems.length > 0) {
  console.error(`装配清单与目录事实不一致（${problems.length} 处）：`)
  for (const problem of problems.sort()) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`✔ 装配清单完整（${features.length} 个功能、3 份进程清单、protocol 契约汇总）`)
