import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/*
 * 安装包冒烟（15 页 §10.6）。
 *
 * 在干净的 Windows 上验证：装得上、起得来、隔离成立、退得干净、卸载保留数据。
 * 不填 API key、不碰界面 —— 走的是静默安装（/S）、静默卸载与 taskkill。
 *
 * 用法：bun apps/desktop/scripts/smoke.ts <安装包路径>
 */

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Poietica')
const APP_DATA = path.join(process.env.APPDATA ?? '', 'Poietica')
const POLL_MS = 500
const INSTALL_TIMEOUT_MS = 120_000
const START_TIMEOUT_MS = 60_000
const QUIT_TIMEOUT_MS = 15_000

const installer = process.argv[2]
if (installer === undefined || !existsSync(installer)) {
  console.error(`用法：bun apps/desktop/scripts/smoke.ts <安装包路径>（收到的：${installer ?? '（空）'}）`)
  process.exit(1)
}

function log(message: string): void {
  console.log(`[smoke] ${message}`)
}

function fail(message: string): never {
  console.error(`[smoke] ❌ ${message}`)
  dumpTail(path.join(APP_DATA, 'logs', 'main.log'))
  dumpTail(path.join(APP_DATA, 'logs', 'core.log'))
  process.exit(1)
}

function dumpTail(file: string): void {
  if (!existsSync(file)) return
  const lines = readFileSync(file, 'utf8').split('\n')
  console.error(`\n[smoke] ---- ${file} 最后 200 行 ----`)
  for (const line of lines.slice(-200)) console.error(line)
}

/** 同步睡眠：整个冒烟脚本是顺序执行的，异步只会让读日志的时序更难判断 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitFor(check: () => boolean, timeoutMs: number, what: string): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    sleep(POLL_MS)
  }
  fail(`等待超时（${Math.round(timeoutMs / 1000)} 秒）：${what}`)
}

function topLevelEntries(): readonly string[] {
  return readdirSync(homedir()).sort()
}

function processName(pid: number): string | null {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const line = (result.stdout ?? '').split('\n')[0] ?? ''
  if (line === '' || line.includes('INFO:')) return null
  const name = /^"([^"]+)"/.exec(line)?.[1]
  return name ?? null
}

function poieticaPids(): readonly number[] {
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Poietica.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return [...(result.stdout ?? '').matchAll(/^"Poietica\.exe","(\d+)"/gm)].map((m) => Number(m[1]))
}

function corePids(): readonly number[] {
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq poietica-core.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return [...(result.stdout ?? '').matchAll(/^"poietica-core\.exe","(\d+)"/gm)].map((m) => Number(m[1]))
}

// ── 1. 记录用户目录的基线（隔离检查用）──────────────────────────────────────
const baseline = topLevelEntries()
const hadDotOmp = existsSync(path.join(homedir(), '.omp'))
const hadLocalShareOmp = existsSync(path.join(homedir(), '.local', 'share', 'omp'))
log(`1/7 用户目录基线：${String(baseline.length)} 个顶层条目；.omp=${String(hadDotOmp)}`)

// ── 2. 静默安装 ─────────────────────────────────────────────────────────────
log(`2/7 静默安装 ${installer}`)
{
  const install = spawnSync(installer, ['/S'], { timeout: INSTALL_TIMEOUT_MS, windowsHide: true })
  if (install.error !== undefined) fail(`安装进程没能跑起来：${String(install.error)}`)
  if (install.status !== 0) fail(`安装退出码是 ${String(install.status)}（要求 0）`)
}
const exe = path.join(INSTALL_DIR, 'Poietica.exe')
waitFor(() => existsSync(exe), 30_000, `${exe} 没出现`)

/* resources/core 下的文件哈希与其中的 core-manifest.json 一致（与 verify-dist 同一条判据） */
{
  const coreDir = path.join(INSTALL_DIR, 'resources', 'core')
  const manifestFile = path.join(coreDir, 'core-manifest.json')
  if (!existsSync(manifestFile)) fail(`安装产物里没有 ${manifestFile}`)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { sha256?: Record<string, string> }
  const expected = manifest.sha256 ?? {}
  for (const name of readdirSync(coreDir)) {
    if (name === 'core-manifest.json') continue
    const want = expected[name]
    if (want === undefined) fail(`resources/core/${name} 在 manifest 里没有哈希`)
    const digest = createHash('sha256')
      .update(readFileSync(path.join(coreDir, name)))
      .digest('hex')
    if (digest !== want) fail(`resources/core/${name} 哈希不一致`)
  }
}
log('2/7 安装完成，resources/core 哈希一致')

// ── 3. 启动 ─────────────────────────────────────────────────────────────────
log('3/7 启动 Poietica.exe')
spawnSync('cmd', ['/c', 'start', '', exe], { windowsHide: true })
const pidFile = path.join(APP_DATA, 'core', 'core.pid')
waitFor(() => existsSync(pidFile), START_TIMEOUT_MS, `${pidFile} 没出现（Core 没起来）`)
const corePid = Number(readFileSync(pidFile, 'utf8').trim())
if (!Number.isInteger(corePid) || corePid <= 0) fail(`core.pid 内容不是数字：${String(corePid)}`)
waitFor(
  () => processName(corePid) === 'poietica-core.exe',
  START_TIMEOUT_MS,
  `pid ${String(corePid)} 不是 poietica-core.exe`,
)
log(`3/7 Core 已就绪（pid ${String(corePid)}）`)

// ── 4. 隔离 ─────────────────────────────────────────────────────────────────
log('4/7 检查隔离')
for (const dir of [path.join(APP_DATA, 'omp', 'agent'), path.join(APP_DATA, 'native-home', 'omp')]) {
  waitFor(() => existsSync(dir) && statSync(dir).isDirectory(), 30_000, `${dir} 没出现`)
}
{
  const after = topLevelEntries()
  const added = after.filter((name) => !baseline.includes(name) && name !== 'AppData')
  if (added.length > 0) fail(`用户目录多出了条目（隔离被破坏）：${added.join(', ')}`)
  if (existsSync(path.join(homedir(), '.omp')) && !hadDotOmp) fail('用户目录多出了 .omp')
  if (existsSync(path.join(homedir(), '.local', 'share', 'omp')) && !hadLocalShareOmp) {
    fail('用户目录多出了 .local\\share\\omp')
  }
}
log('4/7 隔离成立：数据根之外的用户目录零新增')

// ── 5. 日志 ─────────────────────────────────────────────────────────────────
log('5/7 检查日志')
{
  const coreLog = path.join(APP_DATA, 'logs', 'core.log')
  if (existsSync(coreLog)) {
    const text = readFileSync(coreLog, 'utf8')
    const errors = text.split('\n').filter((line) => line.includes('"level":"error"'))
    if (errors.length > 0) fail(`core.log 里有 ${String(errors.length)} 条 error：\n${errors.slice(0, 3).join('\n')}`)
    if (text.includes('isolation self-check failed')) fail('core.log 里有 isolation self-check failed')
  }
}
log('5/7 日志干净')

// ── 6. 正常退出 ─────────────────────────────────────────────────────────────
log('6/7 关闭窗口（不带 /F）')
{
  const pids = poieticaPids()
  if (pids.length === 0) fail('没找到 Poietica.exe 进程')
  for (const pid of pids) spawnSync('taskkill', ['/PID', String(pid)], { windowsHide: true })
  waitFor(
    () => poieticaPids().length === 0 && corePids().length === 0,
    QUIT_TIMEOUT_MS,
    'Poietica.exe / poietica-core.exe 没有在 15 秒内退完',
  )
}
log('6/7 已干净退出')

// ── 7. 静默卸载 ─────────────────────────────────────────────────────────────
log('7/7 静默卸载')
{
  const uninstaller = path.join(INSTALL_DIR, 'Uninstall Poietica.exe')
  if (!existsSync(uninstaller)) fail(`找不到 ${uninstaller}`)
  const result = spawnSync(uninstaller, ['/S'], { timeout: INSTALL_TIMEOUT_MS, windowsHide: true })
  if (result.status !== 0) fail(`卸载退出码是 ${String(result.status)}（要求 0）`)
  waitFor(() => !existsSync(exe), 60_000, '安装目录没被删除')
  if (!existsSync(APP_DATA)) fail('数据根被卸载删掉了（nsis.deleteAppDataOnUninstall 应为 false）')
}

log('全部通过 ✅')
