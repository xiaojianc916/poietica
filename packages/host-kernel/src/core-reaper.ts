import path from 'node:path'
import type { Logger } from '@poietica/foundation'
import { killTree, listProcesses, type ProcessInfo } from '@poietica/process-kit'

/**
 * omp 的后台 worker 选择子前缀。omp 把 daemon broker 用 `detached: true` 起在 Core 的进程树之外
 * （omp 的 launch/client.ts："The broker must outlive whichever omp process happened to spawn it"），
 * 所以 taskkill /T 够不着它；它和 Core 用同一个 exe，关掉 Core 也不会带走它。
 * 结果就是升级安装时旧的 core.exe 一直被占用，覆盖安装悄悄失败（refactor-log R-37）。
 */
const OMP_WORKER_ARG_PREFIX = '__omp_worker_'

/** 本应用的 Core 可执行文件名。安装版在 <安装目录>\\resources\\core 下，开发版在 apps/core/dist 下。 */
const CORE_EXE_NAME = 'poietica-core.exe'

/** Windows 路径：大小写不敏感，去掉 \\\\?\\ 加长前缀 */
function pathKey(p: string): string {
  return p.toLowerCase().replace(/^\\\\\?\\/, '')
}

/**
 * 本应用 Core 映像名的进程（`poietica-core.exe`）：只问这一个名字。
 *
 * 常态下上一代退得干干净净，tasklist 一问就答「没有」，不再每次起 PowerShell 枚举整张进程表（见 process-kit 的
 * `ListProcessesOptions`）。按名字筛不会比按路径认漏掉什么：{@link findStaleCoreProcesses} 认的进程映像名一定就是它。
 * coreExe 一律按 Windows 路径取文件名（测试在 Linux 上跑时也一样）。
 */
export function listCoreProcesses(coreExe: string): Promise<ProcessInfo[]> {
  return listProcesses({ imageName: path.win32.basename(coreExe) })
}

/** 一条需要清理的残留：上一代 Core，或它派发出来、现在还活着的 omp 后台进程 */
export interface StaleProcess {
  readonly pid: number
  readonly what: 'core' | 'omp-worker'
  readonly commandLine: string
}

export interface ReapOptions {
  readonly logger: Logger
  /** 当前 Host 自己持有的 Core pid；有值就跳过他，绝不动活着的这一代 */
  readonly ownPid: number | undefined
  /** 本应用 Core 的绝对路径；**只清这个路径上的进程**，别的 checkout / 别的安装目录一概不碰 */
  readonly coreExe: string
  /** 默认 {@link listCoreProcesses}；Host 启动时传进来的是一启动就发起的那份快照（见 CoreSupervisorOptions.processSnapshot） */
  readonly list?: () => Promise<ProcessInfo[]>
  /** 测试注入：默认走 killTree（taskkill /T /F） */
  readonly kill?: (pid: number) => Promise<void>
  /** 测试注入：默认是 {@link findStaleCoreProcesses} */
  readonly find?: (processes: readonly ProcessInfo[], ownPid: number | undefined, coreExe: string) => StaleProcess[]
}

/**
 * 只认**本应用这个 core.exe 路径**上的进程，再看命令行分它是正统 Core 还是 omp 后台子进程。
 * 必须按完整路径而不是按文件名：omp 派发 worker 走 `process.execPath`，与 Core 是同一个 exe，
 * 按路径一关就同时覆盖；按文件名认则会误杀别的 checkout / 安装目录里跑着的 Core。
 * 拿不到 ExecutablePath 的受保护进程按文件名认，但要它确实以 core.exe 结尾。
 */
function isCoreProcess(p: ProcessInfo, coreExe: string): boolean {
  const actual = pathKey(p.executablePath)
  if (actual.length > 0) return actual === pathKey(coreExe)
  return pathKey(p.name).endsWith(CORE_EXE_NAME)
}

export function findStaleCoreProcesses(
  processes: readonly ProcessInfo[],
  ownPid: number | undefined,
  coreExe: string,
): StaleProcess[] {
  const stale: StaleProcess[] = []
  for (const p of processes) {
    if (p.pid === ownPid) continue
    if (!isCoreProcess(p, coreExe)) continue
    const worker = p.commandLine.includes(OMP_WORKER_ARG_PREFIX)
    stale.push({ pid: p.pid, what: worker ? 'omp-worker' : 'core', commandLine: p.commandLine })
  }
  return stale
}

/**
 * 启动前把上一代 Core 与它派发的 omp 后台进程清干净，必须在 spawn 之前：
 * 上一代活着会占着 SQLite 与 omp 会话；daemon broker 占着安装目录里的 core.exe，
 * 覆盖安装写不进去、装完就是「新 Host + 旧 Core」，且重装也修不好（refactor-log R-37）。
 * 永不抛错：清理失败只记 warn，启动照常（清理是尽力而为）。
 */
export async function reapStaleCoreProcesses(o: ReapOptions): Promise<StaleProcess[]> {
  const list = o.list ?? (() => listCoreProcesses(o.coreExe))
  const kill = o.kill ?? killTree
  let processes: ProcessInfo[]
  try {
    processes = await list()
  } catch (e) {
    o.logger.warn('进程表读不到，跳过残留检查', { error: String(e) })
    return []
  }
  const find = o.find ?? findStaleCoreProcesses
  /* ownPid 只认 Host 自己手里那一代。core.pid 里记的是**上一代** Core 的 pid —— 那正是要清的，不能拿来跳过。 */
  const stale = find(processes, o.ownPid, o.coreExe)
  if (stale.length === 0) return []
  o.logger.warn('发现上一代 Core / omp 后台进程，启动前清理', {
    processes: stale.map((s) => ({ pid: s.pid, what: s.what })),
  })
  for (const s of stale) {
    try {
      await kill(s.pid)
    } catch (e) {
      o.logger.warn('清理残留进程失败', { pid: s.pid, what: s.what, error: String(e) })
    }
  }
  return stale
}
