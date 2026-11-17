import path from 'node:path'

/**
 * 平台能力的唯一产地（架构审查 D9）。产品只发布 Windows，但进程、安装器、终端与测试会在不同平台跑：
 * 所有 `process.platform`、`.exe` / PowerShell / cmd 的判断都收在这里，其他包只调用语义函数。
 */
export type OsFamily = 'windows' | 'macos' | 'linux' | 'other'

export function familyOf(platform: string): OsFamily {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  return 'other'
}

export const osFamily: OsFamily = familyOf(process.platform)
export const windowsPlatform = 'win32' as const
export const isWindows = osFamily === 'windows'

/** 给人看的平台名（工作台遥测、诊断）。 */
export function platformLabel(platform: string = process.platform): string {
  switch (familyOf(platform)) {
    case 'windows':
      return 'Windows'
    case 'macos':
      return 'macOS'
    case 'linux':
      return 'Linux'
    case 'other':
      return `Other:${platform}`
  }
}

/** 产品随包的可执行文件名固定带 `.exe`（Windows 发布物），不随宿主进程平台变化。 */
export function windowsExecutable(base: string): string {
  return base.toLowerCase().endsWith('.exe') ? base : `${base}.exe`
}

/** 去掉可执行扩展名（比较映像名、拼标题用）。 */
export function stripExecutable(name: string): string {
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name
}

/** 是不是一个可执行映像名。 */
export function isExecutableName(name: string): boolean {
  return name.toLowerCase().endsWith('.exe')
}

/** 系统目录里的固定路径：不走 PATH（PATH 是用户环境，安装器与卸载场景不可信）。 */
export function windowsSystem32(file: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', file)
}

/** 产品实际调用的 Windows 系统命令；路径只在这里拼。 */
export const windowsCommands = Object.freeze({
  taskkill: () => windowsSystem32(windowsExecutable('taskkill')),
  tasklist: () => windowsSystem32(windowsExecutable('tasklist')),
  ps: () => windowsSystem32(`WindowsPowerShell\\v1.0\\${windowsExecutable('powershell')}`),
  cmd: (env: Readonly<Record<string, string | undefined>> = process.env) =>
    windowsSystem32(windowsExecutable('cmd'), env),
})

/** PATH 里没写 PATHEXT 时的默认候选（Windows）。 */
export function defaultPathExtensions(): string[] {
  return ['COM', 'EXE', 'BAT', 'CMD'].map((ext) => `.${ext}`)
}

/** Windows 路径比较键：大小写不敏感，去掉 \\?\ 加长前缀。 */
export function pathKey(value: string): string {
  return isWindows ? value.toLowerCase().replace(/^\\\\\?\\/, '') : value
}

export interface ShellSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly title: string
}

/**
 * 选终端 shell：优先 PowerShell 7，再 Windows PowerShell，再 ComSpec，最后 System32\cmd。
 * `find` 由调用方注入（Electron 主进程不能依赖 Bun.which）。
 */
export async function resolveShell(
  env: Readonly<Record<string, string | undefined>>,
  find: (name: string) => Promise<string | null>,
): Promise<ShellSpec> {
  const pwsh = await find(windowsExecutable('pwsh'))
  if (pwsh !== null) return { file: pwsh, args: ['-NoLogo'], title: 'pwsh' }
  const powershell = await find(windowsExecutable('powershell'))
  if (powershell !== null) return { file: powershell, args: ['-NoLogo'], title: 'powershell' }
  const comspec = env.ComSpec ?? env.COMSPEC
  if (comspec !== undefined && comspec.length > 0) {
    return { file: comspec, args: [], title: stripExecutable(path.basename(comspec)).toLowerCase() }
  }
  return { file: windowsCommands.cmd(env), args: [], title: 'cmd' }
}

/** OpenAI SDK 的 X-Stainless-OS 标签（WorkBuddy 转发要原样模仿的取值）。 */
export function sdkOsLabel(platform: string = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'MacOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'freebsd':
      return 'FreeBSD'
    case 'openbsd':
      return 'OpenBSD'
    case 'android':
      return 'Android'
    default:
      return platform ? `Other:${platform}` : 'Unknown'
  }
}
