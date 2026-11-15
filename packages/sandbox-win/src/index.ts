import { dlopen, FFIType, ptr } from 'bun:ffi'
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'

/**
 * Windows 进程沙箱（架构设计 §13.3 的第二道防线）。
 *
 * L1 用 Job Object 把整个 Runtime Worker 进程树绑在一起：Worker 被结束、Core 退出、
 * 或句柄关闭时，子进程（包括 omp 自己起的 shell、MCP、PTY）一起被终止；同时限制
 * 进程数与内存，避免一个 Worker 拖垮整机。L2 的受限令牌/低完整性级别仍需单独实现，
 * 当前 `restricted` 会明确报不支持，绝不静默降级。
 */
export type SandboxLevel = 'off' | 'job' | 'restricted'

export interface SandboxOptions {
  readonly level: SandboxLevel
  /** L1 的 Job 内存上限（字节）；缺省 4 GiB。 */
  readonly memoryLimitBytes?: number
  /** L1 的 Job 内最大进程数；缺省 64。 */
  readonly activeProcessLimit?: number
}

export interface SandboxedChild extends ChildProcess {
  readonly sandboxLevel: SandboxLevel
  /** 结束整个 Job；比 taskkill /T 可靠，能带走脱离父子关系的进程。 */
  terminateSandbox(): void
}

export interface SandboxSelfCheck {
  readonly ok: boolean
  readonly level: SandboxLevel
  readonly reason: string | null
}

const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x0000_0100
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x0000_0200
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0000_0008
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION 在 x64 上的字节数。 */
const EXTENDED_LIMIT_SIZE = 144
const PROCESS_MEMORY_OFFSET = 112
const JOB_MEMORY_OFFSET = 120
const BASIC_LIMIT_FLAGS_OFFSET = 16

type Kernel32 = {
  CreateJobObjectW: (attributes: unknown, name: unknown) => unknown
  SetInformationJobObject: (job: unknown, infoClass: number, info: unknown, length: number) => boolean
  AssignProcessToJobObject: (job: unknown, process: unknown) => boolean
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown
  CloseHandle: (handle: unknown) => boolean
  TerminateJobObject: (job: unknown, exitCode: number) => boolean
  IsProcessInJob: (process: unknown, job: unknown, result: unknown) => boolean
}

let kernel: Kernel32 | undefined

function kernel32(): Kernel32 {
  if (kernel === undefined) {
    kernel = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
        returns: FFIType.bool,
      },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    }).symbols as unknown as Kernel32
  }
  return kernel
}

function invalid(handle: unknown): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n
}

function openJob(o: SandboxOptions): unknown {
  const k = kernel32()
  const job = k.CreateJobObjectW(null, null)
  if (invalid(job)) throw new Error('CreateJobObjectW 失败')
  const info = Buffer.alloc(EXTENDED_LIMIT_SIZE)
  let flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  const memory = o.memoryLimitBytes ?? 4 * 1024 * 1024 * 1024
  info.writeUInt32LE(flags, BASIC_LIMIT_FLAGS_OFFSET)
  info.writeBigUInt64LE(BigInt(memory), PROCESS_MEMORY_OFFSET)
  info.writeBigUInt64LE(BigInt(memory), JOB_MEMORY_OFFSET)
  flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY
  const active = o.activeProcessLimit ?? 64
  if (active > 0) {
    info.writeUInt32LE(active, 40)
    flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS
  }
  info.writeUInt32LE(flags, BASIC_LIMIT_FLAGS_OFFSET)
  if (!k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(info), info.length)) {
    k.CloseHandle(job)
    throw new Error('SetInformationJobObject 失败')
  }
  return job
}

/** 把已启动的 Worker 放进新 Job；创建/分配失败会杀掉子进程并抛错，调用方决定是否降级。 */
export function spawnSandboxed(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  sandbox: SandboxOptions,
): SandboxedChild {
  if (sandbox.level === 'restricted') {
    throw new Error('sandbox.restricted 尚未实现（需要受限令牌 / 低完整性级别）')
  }
  if (sandbox.level === 'off' || process.platform !== 'win32') {
    const child = nodeSpawn(command, [...args], options) as SandboxedChild
    return Object.assign(child, {
      sandboxLevel: sandbox.level,
      terminateSandbox: () => {
        child.kill()
      },
    })
  }

  const k = kernel32()
  const child = nodeSpawn(command, [...args], options)
  const job = openJob(sandbox)
  const processHandle = k.OpenProcess(
    PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
    false,
    child.pid ?? -1,
  )
  if (invalid(processHandle)) {
    k.CloseHandle(job)
    child.kill()
    throw new Error(`OpenProcess 失败（pid=${child.pid ?? 'unknown'}）`)
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    k.CloseHandle(processHandle)
    k.CloseHandle(job)
  }
  try {
    if (!k.AssignProcessToJobObject(job, processHandle)) {
      throw new Error('AssignProcessToJobObject 失败')
    }
    const result = Buffer.alloc(4)
    if (!k.IsProcessInJob(processHandle, job, ptr(result)) || result.readInt32LE(0) === 0) {
      throw new Error('IsProcessInJob 自检失败')
    }
  } catch (error) {
    close()
    child.kill()
    throw error
  }
  child.once('exit', close)
  return Object.assign(child, {
    sandboxLevel: 'job' as const,
    terminateSandbox: () => {
      if (!closed) k.TerminateJobObject(job, 1)
      child.kill()
      close()
    },
  })
}

/** 启动自检：起一个短命进程、放进 Job，确认它真的在 Job 里。 */
export async function sandboxSelfCheck(level: SandboxLevel): Promise<SandboxSelfCheck> {
  if (level === 'off') return { ok: true, level, reason: null }
  if (process.platform !== 'win32') return { ok: false, level, reason: '仅支持 Windows' }
  if (level === 'restricted') return { ok: false, level, reason: 'restricted 尚未实现' }
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  let child: SandboxedChild | undefined
  try {
    child = spawnSandboxed(comspec, ['/d', '/s', '/c', 'exit 0'], { stdio: 'ignore', windowsHide: true }, { level })
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => reject(new Error('自检进程超时')), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    await promise
    return { ok: true, level, reason: null }
  } catch (error) {
    child?.terminateSandbox()
    return { ok: false, level, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 供 RuntimeProcess 判断返回值是否带 Job 能力。 */
export function isSandboxedChild(child: ChildProcess): child is SandboxedChild {
  return typeof (child as Partial<SandboxedChild>).terminateSandbox === 'function'
}
