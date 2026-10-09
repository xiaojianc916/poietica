import { spawn } from 'node:child_process'
import { killTree } from './kill-tree'

export interface StreamingOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly onStdout?: (chunk: string) => void
  readonly onStderr?: (chunk: string) => void
}

export interface StreamingProcess {
  readonly pid: number | undefined
  /** 进程结束（含启动失败：code 为 null 且 error 有值） */
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null; readonly error: Error | null }>
  writeStdin(text: string): void
  endStdin(): void
  /** 杀整棵进程树；进程已结束时无效果 */
  kill(): Promise<void>
}

/** 长时间运行、需要边运行边读输出的子进程（例如插件安装命令） */
export function spawnStreaming(command: string, args: readonly string[], o: StreamingOptions = {}): StreamingProcess {
  const child = spawn(command, [...args], {
    cwd: o.cwd,
    env: o.env as NodeJS.ProcessEnv | undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })
  let exited = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => o.onStdout?.(chunk))
  child.stderr.on('data', (chunk: string) => o.onStderr?.(chunk))
  child.stdin.on('error', () => undefined)
  const exit = new Promise<{ code: number | null; signal: string | null; error: Error | null }>((resolve) => {
    child.once('error', (error) => {
      exited = true
      resolve({ code: null, signal: null, error })
    })
    child.once('close', (code, signal) => {
      exited = true
      resolve({ code, signal, error: null })
    })
  })
  return {
    pid: child.pid,
    exit,
    writeStdin: (text) => {
      if (!exited) child.stdin.write(text)
    },
    endStdin: () => {
      if (!exited) child.stdin.end()
    },
    kill: async () => {
      if (exited || child.pid === undefined) return
      await killTree(child.pid)
    },
  }
}
