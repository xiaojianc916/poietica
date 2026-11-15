/**
 * 把 omp 四个包推到 npm 最新版并安装（ADR-013）。默认只升级、不跑检查；
 * CI 升级工作流在它之后跑类型检查、engine-omp 样本回归与 Core 冒烟。
 *
 * 用法：
 *   bun run tooling/checks/omp-upgrade-pull.ts             # 写入并安装
 *   bun run tooling/checks/omp-upgrade-pull.ts --dry-run   # 只报告版本
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const PACKAGE = path.join(ROOT, 'package.json')
const PACKAGES = ['@oh-my-pi/pi-ai', '@oh-my-pi/pi-coding-agent', '@oh-my-pi/pi-tui', '@oh-my-pi/pi-utils'] as const

const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
  catalog?: Record<string, string>
  overrides?: Record<string, string>
}

let changed = false
for (const name of PACKAGES) {
  const output = await Bun.$`bun info ${name} version`.cwd(ROOT).text()
  const latest = output.trim().split(/\r?\n/).at(-1) ?? ''
  if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error(`读不到 ${name} 的最新版本：${output}`)
  const current = pkg.catalog?.[name] ?? pkg.overrides?.[name] ?? '(未锁定)'
  console.log(`[omp-pull] ${name}: ${current} → ${latest}`)
  if (current === latest) continue
  changed = true
  if (process.argv.includes('--dry-run')) continue
  if (pkg.catalog !== undefined) pkg.catalog[name] = latest
  if (pkg.overrides !== undefined) pkg.overrides[name] = latest
}

if (!changed) {
  console.log('[omp-pull] 已是最新版本')
  process.exit(0)
}
if (process.argv.includes('--dry-run')) {
  console.log('[omp-pull] dry-run：未写 package.json')
  process.exit(0)
}
writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`)
console.log('[omp-pull] 已更新 package.json，开始安装…')
const install = Bun.spawn(['bun', 'install'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
const code = await install.exited
if (code !== 0) throw new Error(`bun install 失败：${code}`)
console.log('[omp-pull] 安装完成；接着跑类型检查、engine-omp 样本与 check:omp-upgrade')
