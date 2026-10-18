import { execFile } from 'node:child_process'

/** 一条系统进程记录（只取我们判断所需的字段） */
export interface ProcessInfo {
  readonly pid: number
  readonly parentPid: number
  readonly name: string
  readonly executablePath: string
  readonly commandLine: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 一条 Win32_Process 记录 → ProcessInfo；没有 pid 的丢掉 */
function rowOf(row: unknown): ProcessInfo | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  if (typeof r.pid !== 'number') return null
  return {
    pid: r.pid,
    parentPid: typeof r.parentPid === 'number' ? r.parentPid : 0,
    name: text(r.name),
    executablePath: text(r.executablePath),
    commandLine: text(r.commandLine),
  }
}

/**
 * 解析 `Get-CimInstance Win32_Process | ConvertTo-Json` 的输出。
 *
 * `ConvertTo-Json` 在单个元素时给对象、多个时给数组，空集时给空串——三种都要认。
 * 字段可能缺失（受保护进程读不到 Path / CommandLine），缺失一律给空串。
 */
export function parseProcessList(json: string): ProcessInfo[] {
  const trimmed = json.trim()
  if (trimmed.length === 0) return []
  const decoded: unknown = JSON.parse(trimmed)
  const rows = Array.isArray(decoded) ? decoded : [decoded]
  return rows.map(rowOf).filter((row): row is ProcessInfo => row !== null)
}

/** PowerShell 的固定路径：不走 PATH（PATH 是用户环境，安装器与卸载场景不可信） */
function powershellPath(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

const LIST_SCRIPT = [
  // 中文用户名、中文路径：不显式设成 UTF-8，转成字符串时会被按本地代码页解错
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
  'Get-CimInstance -ClassName Win32_Process |',
  'Select-Object @{n="pid";e={$_.ProcessId}},@{n="parentPid";e={$_.ParentProcessId}},',
  'Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
].join(' ')

/**
 * 列出系统进程。只有 Windows 实现：本产品只发布 Windows（AGENTS §1），其它平台返回空表，
 * 调用方的「清理残留」会退化成空操作，而不是抛错。
 *
 * 为什么要枚举而不是查 pid 文件：omp 的 daemon broker 是以 `detached: true` 起的
 * `poietica-core.exe __omp_worker_*`，它不在任何 Core 的进程树里（taskkill /T 够不着），
 * 跨版本一直活着，占着 exe 映像、SQLite 与命名管道（见 refactor-log R-37）。
 * 永不 reject：枚举失败当「没看到进程」，由调用方自己决定要不要重试。
 */
export function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise<ProcessInfo[]>((resolve) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LIST_SCRIPT],
      { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null && stdout.trim().length === 0) {
          resolve([])
          return
        }
        try {
          resolve(parseProcessList(stdout))
        } catch {
          resolve([])
        }
      },
    )
  })
}
