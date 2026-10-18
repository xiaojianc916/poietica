import { workerHostEntry } from '@oh-my-pi/pi-utils/worker-host'
import type { MediaGcResult } from '@poietica/engine'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { MAINTENANCE_MODE } from '../bootstrap/maintenance'

/** 一次全量标记最多跑多久：会话文件再多也不该超过这个量级；超时 Bun 杀掉子进程，下次启动再来 */
const GC_TIMEOUT_MS = 120_000
const STDERR_TAIL = 2_000

/**
 * 重新进入 Core 自己入口的命令：编译版就是 exe 本身，开发版是 bun + 入口模块（process-mode.ts 顶层
 * declareWorkerHostEntry 记下的那个）。不用 omp 的 resolveCliEntryCmd：它在找不到入口时退回 omp 自己的 cli.ts、
 * exe 被删时去 PATH 上找 `omp` —— 那样跑起来的是用户机器上另一个 omp 的 `gc`，默认还会归档会话。
 */
export function coreSelfCommand(
  compiled: boolean = process.env.PI_COMPILED === 'true',
  entry: string | null = workerHostEntry(),
): string[] {
  if (compiled) return [process.execPath]
  if (entry === null) throw new AppError(SystemErrorCode.internal, '不在 Core 的入口里运行，拉不起维护子进程')
  return [process.execPath, entry]
}

/** omp `gc --json` 的输出里我们要的那一段（BlobGcResult） */
export function parseGcOutput(stdout: string): MediaGcResult {
  const start = stdout.indexOf('{')
  let parsed: unknown
  try {
    parsed = start < 0 ? undefined : JSON.parse(stdout.slice(start))
  } catch {
    parsed = undefined
  }
  const blobs = (parsed as { blobs?: { deleted?: unknown; bytes?: unknown; errors?: unknown } } | undefined)?.blobs
  if (typeof blobs?.deleted !== 'number' || typeof blobs.bytes !== 'number') {
    throw new AppError(SystemErrorCode.internal, `看不懂 omp gc 的输出：${stdout.slice(0, STDERR_TAIL)}`)
  }
  return {
    deletedFiles: blobs.deleted,
    freedBytes: blobs.bytes,
    errors: Array.isArray(blobs.errors) ? blobs.errors.map(String) : [],
  }
}

export interface OmpMediaGcOptions {
  /** 测试注入：拉起哪个进程（默认 coreSelfCommand） */
  readonly command?: () => readonly string[]
  readonly timeoutMs?: number
}

/**
 * 会话媒体回收（SessionFilesPort.collectGarbage 的实现）：拉起 `<core> gc --agent-dir <dir>`
 * （bootstrap/maintenance.ts），等它跑完，读它打印的 JSON。
 *
 * omp 的规则原样生效：标记 = 会话目录（含子代理的会话、归档目录）里所有 `blob:sha256:` 引用；没被引用、且 5 分钟内
 * 没写过的 blob 删掉；有 gc 锁，两个进程不会同时扫。Core 自己按内容寻址补写的小图（session/media-store.ts 的
 * blobMediaRef）不在会话文件里引用，会被当成垃圾回收 —— 那正是对的：它们的字节内联在会话文件里，下次投影这条会话时
 * blobMediaRef 会再写一份，而本进程刚写过的都在 5 分钟宽限之内。
 */
export function ompMediaGc(
  agentDir: string,
  o: OmpMediaGcOptions = {},
): (signal?: AbortSignal) => Promise<MediaGcResult> {
  return async (signal) => {
    /* 子进程跑的是 Core 自己的 exe：应用退出（升级要替换 exe）时必须一起停，不能让它在后台占着文件 */
    const proc = Bun.spawn([...(o.command ?? coreSelfCommand)(), MAINTENANCE_MODE, '--agent-dir', agentDir], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: o.timeoutMs ?? GC_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      const why = proc.signalCode === null ? `退出码 ${code}` : `被 ${proc.signalCode} 结束`
      throw new AppError(SystemErrorCode.internal, `会话媒体回收没有跑完（${why}）：${stderr.slice(-STDERR_TAIL)}`)
    }
    return parseGcOutput(stdout)
  }
}
