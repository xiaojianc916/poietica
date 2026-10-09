import { spawn } from 'node:child_process'
import { killTree } from './kill-tree'

export interface RunOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
  /** 默认不超时 */
  readonly timeoutMs?: number
  /** 写入 stdin 的内容；不提供则立即关闭 stdin */
  readonly input?: string
  /** 视为成功的退出码，默认 [0] */
  readonly okExitCodes?: readonly number[]
  /** stdout/stderr 各自保留的最大字节数，超出部分丢弃（stdoutTruncated 标记）。默认 16 MB */
  readonly maxOutputBytes?: number
}

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
}

export type RunFailure = 'spawn' | 'exit' | 'timeout' | 'aborted'

/** run 失败。reason：spawn（找不到程序等）、exit（退出码不在 okExitCodes）、timeout、aborted */
export class RunError extends Error {
  override readonly name = 'RunError'
  constructor(
    readonly reason: RunFailure,
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    message: string,
  ) {
    super(message)
  }
}

/** 运行到结束并收集输出（UTF-8）。超时或中止时杀整棵进程树 */
export function run(command: string, args: readonly string[], o: RunOptions = {}): Promise<RunResult> {
  const okCodes = o.okExitCodes ?? [0]
  const limit = o.maxOutputBytes ?? 16 * 1024 * 1024
  return new Promise<RunResult>((resolve, reject) => {
    if (o.signal?.aborted === true) {
      reject(new RunError('aborted', command, args, null, '', '', `${command} 已取消`))
      return
    }
    const child = spawn(command, [...args], {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv | undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let failure: RunFailure | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const stop = (reason: RunFailure): void => {
      if (failure !== null) return
      failure = reason
      if (child.pid !== undefined) void killTree(child.pid)
    }
    const onAbort = (): void => stop('aborted')
    o.signal?.addEventListener('abort', onAbort, { once: true })
    if (o.timeoutMs !== undefined && o.timeoutMs > 0) timer = setTimeout(() => stop('timeout'), o.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const n = Buffer.byteLength(chunk)
      if (stdoutBytes + n > limit) {
        truncated = true
        return
      }
      stdoutBytes += n
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      const n = Buffer.byteLength(chunk)
      if (stderrBytes + n > limit) return
      stderrBytes += n
      stderr += chunk
    })
    child.stdin.on('error', () => undefined) // 进程不读 stdin 就退出时的 EPIPE
    if (o.input !== undefined) child.stdin.end(o.input)
    else child.stdin.end()

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
    }
    child.once('error', (error) => {
      cleanup()
      reject(new RunError('spawn', command, args, null, stdout, stderr, `无法启动 ${command}：${error.message}`))
    })
    child.once('close', (code) => {
      cleanup()
      const exitCode = code ?? -1
      if (failure === 'timeout') {
        reject(new RunError('timeout', command, args, exitCode, stdout, stderr, `${command} 超时（${o.timeoutMs}ms）`))
      } else if (failure === 'aborted') {
        reject(new RunError('aborted', command, args, exitCode, stdout, stderr, `${command} 已取消`))
      } else if (!okCodes.includes(exitCode)) {
        reject(
          new RunError(
            'exit',
            command,
            args,
            exitCode,
            stdout,
            stderr,
            `${command} 退出码 ${exitCode}：${stderr.slice(0, 500)}`,
          ),
        )
      } else {
        resolve({ exitCode, stdout, stderr, stdoutTruncated: truncated })
      }
    })
  })
}
