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

/**
 * 取一个字段：PowerShell 的 `ConvertTo-Json` 保留 Win32_Process 的原始大小写
 * （`Name` / `ExecutablePath` / `CommandLine`），而 `Select-Object` 的两个计算属性是我们自己起的
 * 小写名（`pid` / `parentPid`）。两种都认，写死一边就有一边会静默变成空串。
 */
function field(r: Record<string, unknown>, lower: string, upper: string): unknown {
  return r[lower] ?? r[upper]
}

/** 一条 Win32_Process 记录 → ProcessInfo；没有 pid 的丢掉 */
function rowOf(row: unknown): ProcessInfo | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  const pid = field(r, 'pid', 'ProcessId')
  if (typeof pid !== 'number') return null
  const parentPid = field(r, 'parentPid', 'ParentProcessId')
  return {
    pid,
    parentPid: typeof parentPid === 'number' ? parentPid : 0,
    name: text(field(r, 'name', 'Name')),
    executablePath: text(field(r, 'executablePath', 'ExecutablePath')),
    commandLine: text(field(r, 'commandLine', 'CommandLine')),
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

/** 系统目录里的固定路径：不走 PATH（PATH 是用户环境，安装器与卸载场景不可信） */
function system32(exe: string): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\${exe}`
}

const SELECT_FIELDS = [
  'Select-Object @{n="pid";e={$_.ProcessId}},@{n="parentPid";e={$_.ParentProcessId}},',
  'Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
].join(' ')

/** 映像名只认这一类字符：要拼进 tasklist 的过滤式与 WQL 的字符串字面量，不给引号与通配留余地 */
const IMAGE_NAME = /^[\w.\- ]+$/

/** 导出给测试：PowerShell 脚本本身（WQL 过滤式的引号层次最容易写错） */
export function cimListScript(imageName: string | undefined): string {
  // 中文用户名、中文路径：不显式设成 UTF-8，转成字符串时会被按本地代码页解错
  const head = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance -ClassName Win32_Process'
  /*
   * WQL 过滤在 CIM 服务端做：只把同名的几行序列化回来，而不是整张进程表（几百行，每行带完整命令行）。
   * PowerShell 单引号串里 '' 是一个单引号 → WQL 收到 Name='poietica-core.exe'；整段不含双引号，不受命令行转义影响。
   */
  const filter = imageName === undefined ? '' : ` -Filter 'Name=''${imageName}'''`
  return `${head}${filter} | ${SELECT_FIELDS}`
}

export interface ListProcessesOptions {
  /**
   * 只要这个映像名的进程（大小写不敏感）。给了就分两步：tasklist 先问「有没有」（系统自带，
   * 几十毫秒），真有同名才起 PowerShell 用 WQL 取路径与命令行 —— 常态（上一代退干净）只付
   * 第一步，PowerShell 起进程加 CIM 模块要 0.5s 上下。tasklist 问不了时照旧走第二步，不会漏清。
   */
  readonly imageName?: string
}

/**
 * 解析 `tasklist /NH /FO CSV` 的输出：每个进程一行 `"映像名","PID","会话名","会话#","内存使用"`。
 * 没有匹配时 tasklist 只打一行本地化的「信息: 没有运行的任务匹配指定标准。」—— 不是 CSV 行，直接略过。
 */
export function parseTasklistCsv(stdout: string): Array<{ readonly name: string; readonly pid: number }> {
  const rows: Array<{ readonly name: string; readonly pid: number }> = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('"')) continue
    const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '')
    const name = fields[0]
    const pid = Number(fields[1])
    if (name === undefined || name.length === 0 || !Number.isInteger(pid) || pid <= 0) continue
    rows.push({ name, pid })
  }
  return rows
}

/** 有没有这个映像名的进程。`null` = 问不了（tasklist 起不来 / 超时）：调用方按「不知道」处理 */
function anyProcessNamed(imageName: string): Promise<boolean | null> {
  return new Promise<boolean | null>((resolve) => {
    execFile(
      system32('tasklist.exe'),
      ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${imageName}`],
      { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolve(null)
          return
        }
        const wanted = imageName.toLowerCase()
        resolve(parseTasklistCsv(stdout).some((row) => row.name.toLowerCase() === wanted))
      },
    )
  })
}

function queryCim(imageName: string | undefined): Promise<ProcessInfo[]> {
  return new Promise<ProcessInfo[]>((resolve) => {
    execFile(
      system32('WindowsPowerShell\\v1.0\\powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cimListScript(imageName)],
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

/**
 * 列出系统进程。只有 Windows 实现：本产品只发布 Windows，其它平台返回空表，
 * 调用方的「清理残留」退化成空操作而不是抛错。要枚举而不是查 pid 文件，是因为 omp 的 daemon
 * broker 以 `detached: true` 起在 Core 的进程树之外（taskkill /T 够不着），跨版本活着、占着
 * exe 映像、SQLite 与命名管道（refactor-log R-37）。传 `imageName` 时代价跟着「有没有同名进程」
 * 走。永不 reject：枚举失败当「没看到进程」。
 */
export async function listProcesses(o: ListProcessesOptions = {}): Promise<ProcessInfo[]> {
  if (process.platform !== 'win32') return []
  if (o.imageName === undefined) return await queryCim(undefined)
  const wanted = o.imageName.toLowerCase()
  /* 受保护进程读不到 Name 时按空串给：留给调用方按路径兜底，不在这里丢 */
  const sameName = (p: ProcessInfo): boolean => p.name.length === 0 || p.name.toLowerCase() === wanted
  if (!IMAGE_NAME.test(o.imageName)) {
    /* 名字里带了不该拼进过滤式的字符：整表取回来在这边筛 */
    return (await queryCim(undefined)).filter(sameName)
  }
  if ((await anyProcessNamed(o.imageName)) === false) return []
  return (await queryCim(o.imageName)).filter(sameName)
}
