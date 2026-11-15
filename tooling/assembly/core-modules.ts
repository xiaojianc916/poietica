/**
 * 生成 Core 的功能模块清单（P6 生成式装配的第一步）：扫 features/<id>/package.json，
 * 凡导出 `./core` 的功能都进清单；手工清单只留 retiredCoreModules。
 *
 * 用法：
 *   bun run tooling/assembly/core-modules.ts          # 写入
 *   bun run tooling/assembly/core-modules.ts --check  # CI 校验是否最新
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const FEATURES = path.join(ROOT, 'features')
const OUTPUT = path.join(ROOT, 'apps/core/src/modules.generated.ts')

const KINDS = new Set(['domain', 'capability', 'agent-runtime', 'agent-tool', 'integration', 'surface'])
const TIERS = JSON.parse(readFileSync(path.join(ROOT, 'tooling/depcruise/feature-tiers.json'), 'utf8')) as Record<
  string,
  number
>

interface Feature {
  readonly id: string
  readonly packageName: string
  readonly variable: string
  readonly kind: string
  readonly tier: number
  readonly contract: boolean
  readonly processes: readonly string[]
}

function features(): Feature[] {
  const out: Feature[] = []
  for (const id of readdirSync(FEATURES).sort()) {
    const pkgFile = path.join(FEATURES, id, 'package.json')
    if (!existsSync(pkgFile)) continue
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
      name?: string
      exports?: Record<string, string>
      poietica?: { kind?: string }
    }
    if (typeof pkg.name !== 'string' || pkg.exports?.['./core'] === undefined) continue
    const kind = pkg.poietica?.kind
    if (kind === undefined || !KINDS.has(kind)) {
      throw new Error(`features/${id}/package.json 缺少合法 poietica.kind（${[...KINDS].join('/')}）`)
    }
    const variable = id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const tier = TIERS[id]
    if (tier === undefined) throw new Error(`features/${id} 没有在 tooling/depcruise/feature-tiers.json 登记级别`)
    out.push({
      id,
      packageName: pkg.name,
      variable,
      kind,
      tier,
      contract: pkg.exports['./contract'] !== undefined,
      processes: [
        'core',
        ...(pkg.exports['./host'] === undefined ? [] : ['host']),
        ...(pkg.exports['./ui'] === undefined ? [] : ['ui']),
      ],
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function render(): string {
  const list = features()
  const imports = list.map((f) => `import ${f.variable} from '${f.packageName}/core'`).join('\n')
  const descriptors = list
    .map(
      (f) =>
        `  ${f.id.includes('-') ? `'${f.id}'` : f.id}: {\n    id: '${f.id}',\n    kind: '${f.kind}',\n    tier: ${f.tier},\n    processes: [${f.processes.map((p) => `'${p}'`).join(', ')}],\n    hasContract: ${f.contract},\n    module: ${f.variable},\n  },`,
    )
    .join('\n')
  return `// 由 tooling/assembly/core-modules.ts 生成；不要手改。\n\nimport type { CoreModule, CoreModuleDescriptor } from '@poietica/core-kernel'\n${imports}\n\nexport interface FeatureDescriptor extends CoreModuleDescriptor {\n  readonly hasContract: boolean\n}\n\nexport const featureDescriptors = {\n${descriptors}\n} as const satisfies Record<string, FeatureDescriptor>\n\nexport const coreModules: readonly CoreModule[] = Object.values(featureDescriptors).map(\n  (descriptor) => descriptor.module,\n)\n`
}

const expected = render()
const check = process.argv.includes('--check')
const actual = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''

if (check) {
  if (actual !== expected) {
    console.error('[core-modules] 清单不是最新；运行 bun run assembly:core')
    process.exit(1)
  }
  console.log(`[core-modules] ${features().length} 个功能已是最新`)
} else {
  writeFileSync(OUTPUT, expected)
  console.log(`[core-modules] 已写入 ${path.relative(ROOT, OUTPUT)}（${features().length} 个功能）`)
}
