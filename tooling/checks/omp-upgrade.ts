/**
 * omp 升级检查（ADR-013）：记录随包 omp 的版本与公开导出；升级后必须先跑 --write 生成变更报告，
 * 再把差异写进提交说明。差异未确认时 check 失败，避免「装上新版就当适配完成」。
 *
 * 用法：
 *   bun run tooling/checks/omp-upgrade.ts           # 检查
 *   bun run tooling/checks/omp-upgrade.ts --write   # 接受当前版本并重写基线
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const ENGINE_DIR = path.join(ROOT, 'packages/engine-omp')
const BASELINE = path.join(import.meta.dir, 'omp-upgrade-baseline.json')

interface Baseline {
  readonly version: string
  readonly exports: readonly string[]
  readonly tools: readonly string[]
  readonly settings: readonly string[]
}

interface Probe {
  readonly version: string
  readonly exports: readonly string[]
  readonly tools: readonly string[]
  readonly settings: readonly string[]
}

const PROBE = `
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const mod = await import('@oh-my-pi/pi-coding-agent')
const settingsMod = await import('@oh-my-pi/pi-coding-agent/config/all-settings')
const tools = mod.BUILTIN_TOOLS === undefined ? [] : Object.keys(mod.BUILTIN_TOOLS).sort()
const settings = settingsMod.orderedSettings().map((s) => \`\${s.id}:\${s.type}\`).sort()
const url = import.meta.resolve('@oh-my-pi/pi-coding-agent')
let dir = path.dirname(fileURLToPath(url))
while (!fs.existsSync(path.join(dir, 'package.json'))) {
  const parent = path.dirname(dir)
  if (parent === dir) throw new Error('找不到 omp package.json')
  dir = parent
}
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
process.stdout.write(JSON.stringify({ version: pkg.version, exports: Object.keys(mod).sort(), tools, settings }))
`

async function probe(): Promise<Probe> {
  const child = Bun.spawn([process.execPath, '-e', PROBE], {
    cwd: ENGINE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`omp 探测失败（${code}）：${stderr.slice(0, 2000)}`)
  return JSON.parse(stdout) as Probe
}

function difference(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const old = new Set(before)
  const now = new Set(after)
  return {
    added: after.filter((name) => !old.has(name)),
    removed: before.filter((name) => !now.has(name)),
  }
}

const current = await probe()
const write = process.argv.includes('--write')

if (write) {
  const baseline: Baseline = {
    version: current.version,
    exports: current.exports,
    tools: current.tools,
    settings: current.settings,
  }
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(
    `[omp-upgrade] 已记录 omp ${current.version}，${current.exports.length} 个公开导出、${current.tools.length} 个内置工具、${current.settings.length} 个设置项`,
  )
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error('[omp-upgrade] 缺少基线；先运行 --write')
  process.exit(1)
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline
const { added, removed } = difference(baseline.exports, current.exports)
const tools = difference(baseline.tools ?? [], current.tools)
const settings = difference(baseline.settings ?? [], current.settings)
const versionChanged = baseline.version !== current.version

if (
  !versionChanged &&
  added.length === 0 &&
  removed.length === 0 &&
  tools.added.length === 0 &&
  tools.removed.length === 0 &&
  settings.added.length === 0 &&
  settings.removed.length === 0
) {
  console.log(
    `[omp-upgrade] omp ${current.version} 与基线一致（${current.exports.length} 个公开导出、${current.tools.length} 个工具、${current.settings.length} 个设置）`,
  )
  process.exit(0)
}

console.error(`[omp-upgrade] omp 能力有变化：${baseline.version} → ${current.version}`)
if (added.length > 0)
  console.error(`  + ${added.length} 个新导出：${added.slice(0, 20).join(', ')}${added.length > 20 ? ' …' : ''}`)
if (removed.length > 0)
  console.error(
    `  - ${removed.length} 个消失导出：${removed.slice(0, 20).join(', ')}${removed.length > 20 ? ' …' : ''}`,
  )
if (tools.added.length > 0) console.error(`  + 新工具：${tools.added.join(', ')}`)
if (tools.removed.length > 0) console.error(`  - 消失工具：${tools.removed.join(', ')}`)
if (settings.added.length > 0)
  console.error(
    `  + ${settings.added.length} 个新设置：${settings.added.slice(0, 20).join(', ')}${settings.added.length > 20 ? ' …' : ''}`,
  )
if (settings.removed.length > 0)
  console.error(
    `  - ${settings.removed.length} 个消失设置：${settings.removed.slice(0, 20).join(', ')}${settings.removed.length > 20 ? ' …' : ''}`,
  )
console.error('  先确认迁移影响，再运行 bun run tooling/checks/omp-upgrade.ts --write 记录基线。')
process.exit(1)
