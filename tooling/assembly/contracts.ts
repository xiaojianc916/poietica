/**
 * 生成全应用契约汇总：扫 features/<id>/package.json，凡导出 ./contract 的功能都并入。
 * 人工只维护功能目录与各自 contract，不再维护 protocol 里的 import/调用清单。
 *
 * 用法：
 *   bun run tooling/assembly/contracts.ts          # 写入
 *   bun run tooling/assembly/contracts.ts --check  # CI 校验是否最新
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const FEATURES = path.join(ROOT, 'features')
const OUTPUT = path.join(ROOT, 'packages/protocol/src/contracts.generated.ts')

interface Feature {
  readonly id: string
  readonly packageName: string
  readonly variable: string
}

function features(): Feature[] {
  const out: Feature[] = []
  for (const id of readdirSync(FEATURES).sort()) {
    const pkgFile = path.join(FEATURES, id, 'package.json')
    if (!existsSync(pkgFile)) continue
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
      name?: string
      exports?: Record<string, string>
    }
    if (typeof pkg.name !== 'string' || pkg.exports?.['./contract'] === undefined) continue
    const base = id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    out.push({ id, packageName: pkg.name, variable: `${base}Contract` })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function render(): string {
  const list = features()
  const imports = list.map((f) => `import { ${f.variable} } from '${f.packageName}/contract'`).join('\n')
  const entries = list.map((f) => `  ${f.variable},`).join('\n')
  return `// 由 tooling/assembly/contracts.ts 生成；不要手改。\n\nimport type { Contract } from '@poietica/contract-kit'\n${imports}\n\nexport const featureContracts = [\n${entries}\n] as const satisfies readonly Contract[]\n`
}

const expected = render()
const check = process.argv.includes('--check')
const actual = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''

if (check) {
  if (actual !== expected) {
    console.error('[contracts] 契约汇总不是最新；运行 bun run assembly:contracts')
    process.exit(1)
  }
  console.log(`[contracts] ${features().length} 个契约已是最新`)
} else {
  writeFileSync(OUTPUT, expected)
  console.log(`[contracts] 已写入 ${path.relative(ROOT, OUTPUT)}（${features().length} 个契约）`)
}
