import path from 'node:path'
import { isInside } from '@poietica/fs-kit'
import { pathKey, windowsCommands, windowsExecutable } from '@poietica/platform-kit'

/* 找本机已经装好的 Python。来源按可靠性排序：py 启动器的 `-0p` 输出（它自己读注册表，且路径是 UTF-8）、
 * 注册表（启动器被关掉时兜底）、PATH、常见安装目录。每个候选都要真跑一次才知道能不能用 —— 注册表里
 * 经常留着卸载了一半的条目（本机 3.13 就是），只看注册表会把一个起不来的解释器报成 ready。 */

export interface CommandBytes {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly code: number
}

export interface DetectionDeps {
  readonly run: (cmd: string, args: readonly string[], timeoutMs: number) => Promise<CommandBytes>
  readonly exists: (path: string) => Promise<boolean>
  readonly readdir: (dir: string) => Promise<readonly string[]>
  readonly which: (name: string) => Promise<string | null>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly legacyDir: string
  /** 已经配置在 `python.interpreter` 里的那一个：它可能不在 PATH / 注册表里（venv），也要参与验证。 */
  readonly current: string | null
  readonly log: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

export type CandidateSource = 'launcher' | 'registry' | 'path' | 'known' | 'current'

export interface PythonCandidate {
  readonly path: string
  readonly version: string
  /** uv / Astral 管的解释器：能用，但排在正常安装之后。 */
  readonly managed: boolean
  /** `py -0p` 里带 `*` 的那一个。 */
  readonly default: boolean
  readonly source: CandidateSource
}

interface RawCandidate {
  readonly path: string
  readonly managed: boolean
  readonly default: boolean
  readonly source: CandidateSource
}

const PROBE_SCRIPT = 'import sys;print(sys.version.split()[0]);print(sys.executable)'
const PROBE_TIMEOUT_MS = 5_000
const QUERY_TIMEOUT_MS = 10_000
const VERSION_PREFIX = /^\d+\.\d+(?:\.\d+)?/

/* PowerShell 的 `[Console]::OutputEncoding` 先设成 UTF-8，用户名里的中文才不会变成乱码；reg.exe 的输出是
 * 控制台代码页，混着读会拿到两种编码。 */
const REGISTRY_SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
  "foreach($root in @('HKCU:\\Software\\Python\\PythonCore','HKLM:\\Software\\Python\\PythonCore','HKLM:\\Software\\WOW6432Node\\Python\\PythonCore')){",
  'if(Test-Path $root){',
  'Get-ChildItem $root | ForEach-Object {',
  "$p=Get-ItemProperty -Path ($_.PSPath + '\\InstallPath') -ErrorAction SilentlyContinue;",
  `if($p){ if($p.ExecutablePath){ $p.ExecutablePath } elseif($p.'(default)'){ Join-Path ($p.'(default)'.TrimEnd('\\')) '${windowsExecutable('python')}' } }`,
  '}',
  '}',
  '}',
].join(' ')

export function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = match[3] === undefined ? 0 : Number(match[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null
  return [major, minor, patch]
}

/** 数字逐段比较；3.15 与 3.15.0 相等。解析不了的版本排最后。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return left === null ? (right === null ? 0 : -1) : 1
  for (let i = 0; i < 3; i += 1) {
    const diff = left[i]! - right[i]!
    if (diff !== 0) return diff
  }
  return 0
}

export function parseLauncherOutput(output: string): readonly RawCandidate[] {
  const found: RawCandidate[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*-V:(\S+)\s+(\*\s+)?(.+?)\s*$/.exec(line)
    if (match === null) continue
    const tag = match[1]!
    const markedDefault = match[2] !== undefined
    const rawPath = match[3]!.trim().replace(/^"(.*)"$/, '$1')
    if (!pathKey(rawPath).endsWith(windowsExecutable('python'))) continue
    found.push({
      path: rawPath,
      managed: tag.startsWith('Astral\\') || isManagedPath(rawPath),
      default: markedDefault,
      source: 'launcher',
    })
  }
  return found
}

/** PowerShell 每行一个可执行文件路径；其它行（错误、空行）一律忽略。 */
export function parseRegistryOutput(output: string): readonly string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => pathKey(line).endsWith(windowsExecutable('python')))
}

export async function detectPython(deps: DetectionDeps): Promise<readonly PythonCandidate[]> {
  const raw = await collect(deps)
  const probes = new Map<string, PythonCandidate | null>()

  for (const candidate of dedupeRaw(raw, deps.legacyDir)) {
    if (isIgnored(candidate.path, deps.legacyDir)) continue
    if (!(await deps.exists(candidate.path))) continue
    const probe = await probePython(deps, candidate.path)
    if (probe === null) {
      deps.log('warn', 'Python 候选起不来，已跳过', { path: candidate.path })
      probes.set(pathKey(candidate.path), null)
      continue
    }
    const key = pathKey(probe.path)
    const next: PythonCandidate = {
      path: probe.path,
      version: probe.version,
      managed: candidate.managed,
      default: candidate.default,
      source: candidate.source,
    }
    const previous = probes.get(key)
    probes.set(key, previous === undefined || previous === null ? next : merge(previous, next))
  }

  return [...probes.values()].filter((candidate): candidate is PythonCandidate => candidate !== null).sort(compare)
}

async function collect(deps: DetectionDeps): Promise<readonly RawCandidate[]> {
  const raw: RawCandidate[] = []

  if (deps.current !== null) {
    raw.push({ path: deps.current, managed: isManagedPath(deps.current), default: false, source: 'current' })
  }

  const launcher = await findLauncher(deps)

  if (launcher !== null) {
    const result = await safeRun(deps, launcher, ['-0p'])
    if (result.code === 0) {
      /* uv / Astral 管的解释器不算「系统里装的 Python」：它们在 uv 的缓存目录里，会被 `uv python prune` 清掉，
       * 不是用户平常安装的那一个。用户手动配置的那一个不受这条限制（见 collect 开头的 current）。 */
      raw.push(
        ...parseLauncherOutput(new TextDecoder().decode(result.stdout)).filter((candidate) => !candidate.managed),
      )
    }
  }

  /* py 启动器正常时它已经列全了正常安装；只有它没给出正常安装时才去问注册表（PowerShell 启动要几百毫秒）。 */
  if (!raw.some((candidate) => candidate.source === 'launcher' && !candidate.managed)) {
    raw.push(...(await registryCandidates(deps)))
  }

  raw.push(...(await pathCandidates(deps)))
  raw.push(...(await knownDirectoryCandidates(deps)))
  return raw
}

async function findLauncher(deps: DetectionDeps): Promise<string | null> {
  const windir = deps.env.WINDIR ?? deps.env.SystemRoot
  if (windir !== undefined) {
    const fixed = path.join(windir, windowsExecutable('py'))
    if (await deps.exists(fixed)) return fixed
  }
  const local = deps.env.LOCALAPPDATA
  if (local !== undefined) {
    const perUser = path.join(local, 'Programs', 'Python', 'Launcher', windowsExecutable('py'))
    if (await deps.exists(perUser)) return perUser
  }
  return await deps.which(windowsExecutable('py'))
}

async function registryCandidates(deps: DetectionDeps): Promise<readonly RawCandidate[]> {
  const result = await safeRun(deps, windowsCommands.ps(), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    REGISTRY_SCRIPT,
  ])
  if (result.code !== 0) return []
  const entries = parseRegistryOutput(new TextDecoder().decode(result.stdout))
  return entries
    .filter((entry) => !isManagedPath(entry))
    .map((entry) => ({ path: entry, managed: false, default: false, source: 'registry' as const }))
}

async function pathCandidates(deps: DetectionDeps): Promise<readonly RawCandidate[]> {
  const found: RawCandidate[] = []
  const directories = (deps.env.PATH ?? '').split(';').filter((entry) => entry.length > 0)
  for (const directory of directories) {
    for (const name of [windowsExecutable('python'), windowsExecutable('python3')]) {
      const candidate = path.join(directory, name)
      if ((await deps.exists(candidate)) && !isManagedPath(candidate)) {
        found.push({ path: candidate, managed: false, default: false, source: 'path' })
      }
    }
  }
  return found
}

async function knownDirectoryCandidates(deps: DetectionDeps): Promise<readonly RawCandidate[]> {
  const roots: string[] = []
  const local = deps.env.LOCALAPPDATA
  if (local !== undefined) roots.push(path.join(local, 'Programs', 'Python'))
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = deps.env[key]
    if (root !== undefined) roots.push(root)
  }
  const drive = deps.env.SystemDrive
  if (drive !== undefined) roots.push(drive.endsWith('\\') ? drive : `${drive}\\`)

  const found: RawCandidate[] = []
  for (const root of roots) {
    for (const candidate of await candidatesIn(deps, root)) {
      if (!isManagedPath(candidate)) found.push({ path: candidate, managed: false, default: false, source: 'known' })
    }
  }
  return found
}

async function candidatesIn(deps: DetectionDeps, root: string): Promise<readonly string[]> {
  const entries = await deps.readdir(root).catch(() => [])
  return entries
    .filter((entry) => /^python/i.test(entry))
    .map((entry) => path.join(root, entry, windowsExecutable('python')))
}

async function probePython(
  deps: DetectionDeps,
  candidate: string,
): Promise<{ readonly path: string; readonly version: string } | null> {
  const result = await safeRun(deps, candidate, ['-X', 'utf8', '-c', PROBE_SCRIPT], PROBE_TIMEOUT_MS)
  if (result.code !== 0) return null
  const lines = new TextDecoder()
    .decode(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const first = lines[0]
  if (first === undefined) return null
  const version = VERSION_PREFIX.exec(first)?.[0]
  if (version === undefined) return null
  const reported = lines[1]
  const resolved = reported !== undefined && reported.length > 0 && (await deps.exists(reported)) ? reported : candidate
  return { path: resolved, version }
}

async function safeRun(
  deps: DetectionDeps,
  cmd: string,
  args: readonly string[],
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<CommandBytes> {
  try {
    return await deps.run(cmd, args, timeoutMs)
  } catch (e) {
    deps.log('warn', `执行 ${cmd} 失败`, { error: String(e) })
    return { stdout: new Uint8Array(), stderr: new Uint8Array(), code: -1 }
  }
}

/** 同一个路径可能从启动器、PATH、注册表各来一次：合并信息，别重复起进程。 */
function dedupeRaw(raw: readonly RawCandidate[], legacyDir: string): readonly RawCandidate[] {
  const unique = new Map<string, RawCandidate>()
  for (const candidate of raw) {
    if (isIgnored(candidate.path, legacyDir)) continue
    const key = pathKey(candidate.path)
    const previous = unique.get(key)
    unique.set(key, previous === undefined ? candidate : mergeRaw(previous, candidate))
  }
  return [...unique.values()]
}

function mergeRaw(a: RawCandidate, b: RawCandidate): RawCandidate {
  return {
    path: a.path,
    managed: a.managed && b.managed,
    default: a.default || b.default,
    source: sourceRank(a.source) <= sourceRank(b.source) ? a.source : b.source,
  }
}

function merge(a: PythonCandidate, b: PythonCandidate): PythonCandidate {
  return {
    path: a.path,
    version: compareVersions(a.version, b.version) >= 0 ? a.version : b.version,
    managed: a.managed && b.managed,
    default: a.default || b.default,
    source: sourceRank(a.source) <= sourceRank(b.source) ? a.source : b.source,
  }
}

function compare(a: PythonCandidate, b: PythonCandidate): number {
  const managed = Number(a.managed) - Number(b.managed)
  if (managed !== 0) return managed
  const version = compareVersions(b.version, a.version)
  if (version !== 0) return version
  const isDefault = Number(b.default) - Number(a.default)
  if (isDefault !== 0) return isDefault
  return a.path.localeCompare(b.path)
}

function sourceRank(source: CandidateSource): number {
  switch (source) {
    case 'current':
      return 0
    case 'launcher':
      return 1
    case 'registry':
      return 2
    case 'path':
      return 3
    case 'known':
      return 4
  }
}

function isIgnored(candidate: string, legacyDir: string): boolean {
  if (isInside(legacyDir, candidate)) return true
  /* WindowsApps 里的是 Microsoft Store 的跳转桩：跑起来只会开应用商店，不是解释器。 */
  return pathKey(candidate).includes('\\windowsapps\\')
}

function isManagedPath(candidate: string): boolean {
  return pathKey(candidate).includes('\\uv\\python\\')
}
