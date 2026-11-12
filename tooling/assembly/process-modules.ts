/**
 * 生成 Host 与 UI 的功能模块清单：扫 features/<id>/package.json 的 ./host、./ui。
 * Core 清单在 core-modules.ts，契约汇总在 contracts.ts。
 *
 * 用法：
 *   bun run tooling/assembly/process-modules.ts          # 写入
 *   bun run tooling/assembly/process-modules.ts --check  # CI 校验是否最新
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const FEATURES = path.join(ROOT, 'features')

interface Feature {
  readonly id: string
  readonly packageName: string
  readonly variable: string
}

interface Target {
  readonly sub: 'host' | 'ui'
  readonly type: string
  readonly exportName: string
  readonly output: string
}

const TARGETS: readonly Target[] = [
  {
    sub: 'host',
    type: 'HostModule',
    exportName: 'hostModules',
    output: 'apps/desktop/src/main/modules.generated.ts',
  },
  {
    sub: 'ui',
    type: 'UiFeature',
    exportName: 'uiFeatures',
    output: 'apps/desktop/src/renderer/features.generated.ts',
  },
]

function features(sub: string): Feature[] {
  const out: Feature[] = []
  for (const id of readdirSync(FEATURES).sort()) {
    const pkgFile = path.join(FEATURES, id, 'package.json')
    if (!existsSync(pkgFile)) continue
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
      name?: string
      exports?: Record<string, string>
    }
    if (typeof pkg.name !== 'string' || pkg.exports?.[`./${sub}`] === undefined) continue
    const variable = id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    out.push({ id, packageName: pkg.name, variable })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function render(target: Target): string {
  const list = features(target.sub)
  const imports = list.map((f) => `import ${f.variable} from '${f.packageName}/${target.sub}'`).join('\n')
  const entries = list.map((f) => `  ${f.variable},`).join('\n')
  const kernelPackage = target.sub === 'host' ? '@poietica/host-kernel' : '@poietica/ui-kernel'
  return `// 由 tooling/assembly/process-modules.ts 生成；不要手改。\n\n${imports}\nimport type { ${target.type} } from '${kernelPackage}'\n\nexport const ${target.exportName}: readonly ${target.type}[] = [\n${entries}\n]\n`
}

const check = process.argv.includes('--check')
let stale = false
for (const target of TARGETS) {
  const output = path.join(ROOT, target.output)
  const expected = render(target)
  const actual = existsSync(output) ? readFileSync(output, 'utf8') : ''
  if (check) {
    if (actual !== expected) {
      stale = true
      console.error(`[process-modules] ${target.output} 不是最新；运行 bun run assembly:modules`)
    }
  } else {
    writeFileSync(output, expected)
  }
}
if (check) {
  if (stale) process.exit(1)
  console.log('[process-modules] Host/UI 清单已是最新')
} else {
  console.log('[process-modules] 已写入 Host/UI 清单')
}
