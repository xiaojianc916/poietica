import path from 'node:path'

export interface DataLayout {
  readonly root: string
  readonly preferencesFile: string
  readonly uiStateFile: string
  readonly keymapFile: string
  readonly windowStateFile: string
  readonly coreDir: string
  readonly dbFile: string
  readonly coreCwd: string
  readonly attachmentsDir: string
  readonly scratchDir: string
  readonly ompRoot: string
  readonly ompAgentDir: string
  readonly nativeHomeDir: string
  readonly toolsDir: string
  readonly pythonDir: string
  readonly logsDir: string
  readonly mainLog: string
  readonly coreLog: string
  readonly chromiumSessionDir: string
}

/** 纯函数：只做路径计算，不触碰磁盘。root 必须是绝对路径 */
export function dataLayout(root: string): DataLayout {
  if (!path.isAbsolute(root)) throw new Error(`数据根必须是绝对路径：${root}`)
  const r = path.resolve(root)
  const coreDir = path.join(r, 'core')
  const ompRoot = path.join(r, 'omp')
  const toolsDir = path.join(r, 'tools')
  const logsDir = path.join(r, 'logs')
  return Object.freeze({
    root: r,
    preferencesFile: path.join(r, 'preferences.json'),
    uiStateFile: path.join(r, 'ui-state.json'),
    keymapFile: path.join(r, 'keymap.json'),
    windowStateFile: path.join(r, 'window-state.json'),
    coreDir,
    dbFile: path.join(coreDir, 'poietica.db'),
    coreCwd: path.join(coreDir, 'cwd'),
    attachmentsDir: path.join(r, 'attachments'),
    scratchDir: path.join(r, 'scratch'),
    ompRoot,
    ompAgentDir: path.join(ompRoot, 'agent'),
    nativeHomeDir: path.join(r, 'native-home'),
    toolsDir,
    pythonDir: path.join(toolsDir, 'python'),
    logsDir,
    mainLog: path.join(logsDir, 'main.log'),
    coreLog: path.join(logsDir, 'core.log'),
    chromiumSessionDir: path.join(r, 'session'),
  })
}

export interface ResolveDataRootInput {
  readonly isPackaged: boolean
  /** Electron 的 app.getPath('appData')，即 %APPDATA% */
  readonly appDataDir: string
  /**
   * 命令行开关 --poietica-data-root=<绝对路径> 的值（Host 用 app.commandLine.getSwitchValue 读取，空字符串视为 null）。
   * 只在开发版生效，供冒烟测试与 E2E 测试使用临时数据根；安装版忽略它。
   */
  readonly override: string | null
}

export function resolveDataRoot(input: ResolveDataRootInput): string {
  if (!input.isPackaged && input.override !== null && input.override.length > 0) {
    if (!path.isAbsolute(input.override)) throw new Error(`--poietica-data-root 必须是绝对路径：${input.override}`)
    return path.resolve(input.override)
  }
  return path.join(input.appDataDir, input.isPackaged ? 'Poietica' : 'Poietica Dev')
}
