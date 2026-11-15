/**
 * omp 升级检查（ADR-013）：记录随包 omp 的版本、公开导出、内置工具、命令与设置；
 * 升级后生成变更报告，确认后再 --write 接受新基线。
 *
 * 用法：
 *   bun run tooling/checks/omp-upgrade.ts           # 检查；有变化时写 artifacts/omp-upgrade/report.md 并失败
 *   bun run tooling/checks/omp-upgrade.ts --write   # 接受当前版本、归档报告并重写基线
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const ENGINE_DIR = path.join(ROOT, 'packages/engine-omp')
const BASELINE = path.join(import.meta.dir, 'omp-upgrade-baseline.json')
const REPORT_DIR = path.join(ROOT, 'artifacts/omp-upgrade')
const ARCHIVE_DIR = path.join(ROOT, 'docs/omp-upgrades')

interface Baseline {
  readonly version: string
  readonly exports: readonly string[]
  readonly tools: readonly string[]
  readonly commands?: readonly string[]
  readonly events?: readonly string[]
  readonly settings: readonly string[]
}

interface Probe {
  readonly version: string
  readonly exports: readonly string[]
  readonly tools: readonly string[]
  readonly commands: readonly string[]
  readonly events: readonly string[]
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
const commands = (await mod.discoverSlashCommands({ cwd: ${JSON.stringify(ENGINE_DIR)} }))
  .map((command) => command.name)
  .sort()
const url = import.meta.resolve('@oh-my-pi/pi-coding-agent')
let dir = path.dirname(fileURLToPath(url))
while (!fs.existsSync(path.join(dir, 'package.json'))) {
  const parent = path.dirname(dir)
  if (parent === dir) throw new Error('找不到 omp package.json')
  dir = parent
}
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const eventsFile = path.join(dir, 'dist', 'types', 'session', 'agent-session-events.d.ts')
const events = fs.existsSync(eventsFile)
  ? [...new Set([...fs.readFileSync(eventsFile, 'utf8').matchAll(/type:\\s*"([^"]+)"/g)].map((m) => m[1]))].sort()
  : []
process.stdout.write(JSON.stringify({ version: pkg.version, exports: Object.keys(mod).sort(), tools, commands, events, settings }))
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

function reportOf(
  baseline: Baseline,
  current: Probe,
  diffs: {
    exports: { added: string[]; removed: string[] }
    tools: { added: string[]; removed: string[] }
    commands: { added: string[]; removed: string[] }
    events: { added: string[]; removed: string[] }
    settings: { added: string[]; removed: string[] }
  },
): string {
  const section = (title: string, diff: { added: string[]; removed: string[] }): string =>
    [
      `## ${title}`,
      '',
      `新增 ${diff.added.length}，移除 ${diff.removed.length}`,
      '',
      ...diff.added.map((name) => `- 新增 \`${name}\``),
      ...diff.removed.map((name) => `- 移除 \`${name}\``),
      '',
    ].join('\n')

  return [
    `# omp ${baseline.version} → ${current.version}`,
    '',
    `- 公开导出：${current.exports.length}`,
    `- 内置工具：${current.tools.length}`,
    `- 命令：${current.commands.length}`,
    `- 事件：${current.events.length}`,
    `- 设置项：${current.settings.length}`,
    '',
    section('公开导出', diffs.exports),
    section('内置工具', diffs.tools),
    section('命令', diffs.commands),
    section('事件', diffs.events),
    section('设置项', diffs.settings),
  ].join('\n')
}

const current = await probe()
const write = process.argv.includes('--write')
const baseline: Baseline | null = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline) : null

if (write) {
  const next: Baseline = {
    version: current.version,
    exports: current.exports,
    tools: current.tools,
    commands: current.commands,
    events: current.events,
    settings: current.settings,
  }
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
  if (baseline !== null) {
    const diffs = {
      exports: difference(baseline.exports, current.exports),
      tools: difference(baseline.tools ?? [], current.tools),
      commands: difference(baseline.commands ?? [], current.commands),
      events: difference(baseline.events ?? [], current.events),
      settings: difference(baseline.settings ?? [], current.settings),
    }
    const changed =
      baseline.version !== current.version ||
      Object.values(diffs).some((diff) => diff.added.length > 0 || diff.removed.length > 0)
    if (changed) {
      mkdirSync(ARCHIVE_DIR, { recursive: true })
      writeFileSync(
        path.join(ARCHIVE_DIR, `${baseline.version}-to-${current.version}.md`),
        reportOf(baseline, current, diffs),
      )
    }
  }
  console.log(
    `[omp-upgrade] 已记录 omp ${current.version}，${current.exports.length} 个公开导出、${current.tools.length} 个内置工具、${current.commands.length} 个命令、${current.settings.length} 个设置项`,
  )
  process.exit(0)
}

if (baseline === null) {
  console.error('[omp-upgrade] 缺少基线；先运行 --write')
  process.exit(1)
}

const diffs = {
  exports: difference(baseline.exports, current.exports),
  tools: difference(baseline.tools ?? [], current.tools),
  commands: difference(baseline.commands ?? [], current.commands),
  events: difference(baseline.events ?? [], current.events),
  settings: difference(baseline.settings ?? [], current.settings),
}
const changed =
  baseline.version !== current.version ||
  Object.values(diffs).some((diff) => diff.added.length > 0 || diff.removed.length > 0)

if (!changed) {
  console.log(
    `[omp-upgrade] omp ${current.version} 与基线一致（${current.exports.length} 个公开导出、${current.tools.length} 个工具、${current.commands.length} 个命令、${current.settings.length} 个设置）`,
  )
  process.exit(0)
}

const report = reportOf(baseline, current, diffs)
mkdirSync(REPORT_DIR, { recursive: true })
const reportFile = path.join(REPORT_DIR, 'report.md')
writeFileSync(reportFile, report)
console.error(report)
console.error(`[omp-upgrade] 报告已写入 ${path.relative(ROOT, reportFile)}`)
console.error('  先确认迁移影响，再运行 bun run tooling/checks/omp-upgrade.ts --write 记录基线并归档。')
process.exit(1)
