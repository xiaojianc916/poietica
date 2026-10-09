import { encodeFrame, encodeLine, FrameDecoder } from './frame'
import type { Transport } from './transport'
import { TransportCore } from './transport-core'

/** 最小可读文本流接口：Node/Bun 的 process.stdin、child.stdout 都满足 */
export interface TextReadable {
  setEncoding(encoding: 'utf8'): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** 最小可写文本流接口：child.stdin 满足 */
export interface TextWritable {
  write(chunk: string): unknown
  end(): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** 最小子进程接口：node:child_process 的 ChildProcess 满足 */
export interface ChildProcessLike {
  readonly stdin: TextWritable | null
  readonly stdout: TextReadable | null
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
}

/**
 * Core 侧：从 stdin 读“每行一个 JSON”，通过 writeFrame 写 `\x1e` 帧。
 * writeFrame 由 engine-omp 的 installStdoutGuard() 提供（04 页 §3.2）：它是唯一能写真正 stdout 的函数。
 * stdin 结束（Host 关闭管道或崩溃）→ onClose('stdin closed')。
 */
export function createStdioTransport(o: {
  readonly input: TextReadable
  readonly writeFrame: (frame: string) => void
  readonly onStray: (text: string) => void
}): Transport {
  const core = new TransportCore()
  const decoder = new FrameDecoder(false, (m) => core.deliver(m), o.onStray)
  o.input.setEncoding('utf8')
  o.input.on('data', (chunk) => decoder.push(chunk))
  o.input.on('end', () => core.markClosed('stdin closed'))
  o.input.on('error', (error) => core.markClosed(`stdin error: ${error.message}`))
  return {
    send(message) {
      if (!core.closed) o.writeFrame(encodeFrame(message))
    },
    onMessage: (listener) => core.onMessage(listener),
    onClose: (listener) => core.onClose(listener),
    close(reason) {
      core.markClosed(reason)
    },
  }
}

/**
 * Host 侧：向子进程 stdin 写“每行一个 JSON”，从 stdout 解码 `\x1e` 帧；不带前缀的行交给 onStray。
 * 子进程退出 → onClose('exit <code|signal>')。close() 会结束 stdin（Core 读到 EOF 后自行退出）。
 * stdin 的 'error'（子进程已死时的 EPIPE）被吞掉，因为随后必然有 'exit'。
 */
export function createChildProcessTransport(
  child: ChildProcessLike,
  o: { readonly onStray: (text: string) => void },
): Transport {
  const stdin = child.stdin
  const stdout = child.stdout
  if (stdin === null || stdout === null) throw new Error('子进程必须以 stdio: ["pipe", "pipe", ...] 启动')
  const core = new TransportCore()
  const decoder = new FrameDecoder(true, (m) => core.deliver(m), o.onStray)
  stdout.setEncoding('utf8')
  stdout.on('data', (chunk) => decoder.push(chunk))
  stdin.on('error', () => undefined)
  child.once('exit', (code, signal) => core.markClosed(`exit ${code ?? signal ?? 'unknown'}`))
  return {
    send(message) {
      if (!core.closed) stdin.write(encodeLine(message))
    },
    onMessage: (listener) => core.onMessage(listener),
    onClose: (listener) => core.onClose(listener),
    close(reason) {
      if (core.markClosed(reason)) stdin.end()
    },
  }
}
