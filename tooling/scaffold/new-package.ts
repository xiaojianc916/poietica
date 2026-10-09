// 用法：bun run new:package <name> --layer <0|1|2|3|5> --runtime <neutral|dom|node|bun|electron-main>
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { KEBAB, RUNTIMES, type Runtime, renderPackage } from './templates'
import { fail, ROOT, syncReferences, writeFiles } from './write'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { layer: { type: 'string' }, runtime: { type: 'string' } },
  allowPositionals: true,
})
const name = positionals[0]
if (name === undefined || !KEBAB.test(name)) fail('包名必须是 kebab-case，例如 fs-kit')
const layer = Number(values.layer)
if (!Number.isInteger(layer) || layer < 0 || layer > 5 || layer === 4)
  fail('--layer 必须是 0、1、2、3、5（L4 是 features/，请用 new:feature）')
const runtime = values.runtime as Runtime
if (!RUNTIMES.includes(runtime)) fail(`--runtime 必须是 ${RUNTIMES.join(' | ')}`)

writeFiles(renderPackage(name, runtime))
const layersFile = path.join(ROOT, 'tooling/depcruise/layers.json')
const layers = JSON.parse(readFileSync(layersFile, 'utf8')) as Record<string, number>
if (!(name in layers)) {
  layers[name] = layer
  writeFileSync(layersFile, `${JSON.stringify(layers, null, 2)}\n`)
}
syncReferences()
console.log(`已创建 packages/${name}（L${layer}，${runtime}）。下一步：bun install`)
