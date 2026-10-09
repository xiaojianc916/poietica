import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import { AppError, type Logger } from '@poietica/foundation'
import { MAX_TERMINALS, REPLAY_BYTES, type TerminalInfo } from '../contract/entities'
import { terminalErrors } from '../contract/errors'
import { createOutputBatcher } from './output-batcher'
import { RingBuffer } from './ring-buffer'
import { resolveShell, type ShellSpec, terminalEnv } from './shell'

/** node-pty 的最小形状；index.ts 用 @lydell/node-pty 的 spawn 实现它，测试用假实现 */
export interface Pty {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void }
}
export type PtyFactory = (
  shell: ShellSpec,
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> },
) => Pty

interface Entry {
  info: TerminalInfo
  pty: Pty
  replay: RingBuffer
  batcher: ReturnType<typeof createOutputBatcher>
}

export interface TerminalServiceDeps {
  readonly spawn: PtyFactory
  readonly logger: Logger
  readonly emitOutput: (terminalId: string, data: string) => void
  readonly emitExited: (terminalId: string, exitCode: number | null) => void
  readonly env?: NodeJS.ProcessEnv
  readonly killTree?: (pid: number) => Promise<void>
}

export function createTerminalService(d: TerminalServiceDeps) {
  const env = d.env ?? process.env
  const entries = new Map<string, Entry>()
  let seq = 0
  let shellCache: Promise<ShellSpec> | undefined
  const clampSize = (n: number, max: number): number => Math.max(2, Math.min(max, Math.floor(n)))
  const get = (id: string): Entry => {
    const e = entries.get(id)
    if (e === undefined) throw new AppError(terminalErrors.not_found, '终端不存在或已关闭')
    return e
  }

  async function killPty(e: Entry): Promise<void> {
    try {
      if (d.killTree !== undefined) await d.killTree(e.pty.pid)
      else e.pty.kill()
    } catch (err) {
      d.logger.warn('terminal kill failed', { terminalId: e.info.terminalId, error: String(err) })
    }
  }

  return {
    async open(p: { cwd: string | null; cols: number; rows: number }): Promise<TerminalInfo> {
      const live = [...entries.values()].filter((e) => !e.info.exited).length
      if (live >= MAX_TERMINALS) {
        throw new AppError(terminalErrors.too_many, '最多同时打开 10 个终端')
      }
      const cwd = p.cwd ?? os.homedir()
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new AppError(terminalErrors.cwd_not_found, '工作目录不存在')
      }
      shellCache ??= resolveShell(env)
      const shell = await shellCache
      let pty: Pty
      try {
        pty = d.spawn(shell, { cwd, cols: clampSize(p.cols, 500), rows: clampSize(p.rows, 200), env: terminalEnv(env) })
      } catch (e) {
        d.logger.error('pty spawn failed', { shell: shell.file, error: String(e) })
        throw new AppError(terminalErrors.spawn_failed, '无法启动终端程序')
      }
      const terminalId = `t${++seq}`
      const entry: Entry = {
        info: { terminalId, cwd, shell: shell.file, title: shell.title, exited: false, exitCode: null },
        pty,
        replay: new RingBuffer(REPLAY_BYTES),
        batcher: createOutputBatcher((data) => d.emitOutput(terminalId, data)),
      }
      entries.set(terminalId, entry)
      pty.onData((data) => {
        entry.replay.push(data)
        entry.batcher.push(data)
      })
      pty.onExit(({ exitCode }) => {
        entry.batcher.drain()
        entry.info = { ...entry.info, exited: true, exitCode }
        d.emitExited(terminalId, exitCode)
      })
      d.logger.info('terminal opened', { terminalId, shell: shell.file, pid: pty.pid })
      return entry.info
    },
    write(id: string, data: string): void {
      const e = get(id)
      if (!e.info.exited) e.pty.write(data)
    },
    resize(id: string, cols: number, rows: number): void {
      const e = get(id)
      if (!e.info.exited) e.pty.resize(clampSize(cols, 500), clampSize(rows, 200))
    },
    async close(id: string): Promise<void> {
      const e = get(id)
      entries.delete(id)
      e.batcher.dispose()
      if (!e.info.exited) await killPty(e)
    },
    list(): TerminalInfo[] {
      return [...entries.values()].map((e) => e.info)
    },
    replay(id: string): string {
      return get(id).replay.read()
    },
    /** 退出时调用：杀掉全部 PTY 及其子进程树 */
    async disposeAll(): Promise<void> {
      const all = [...entries.values()]
      entries.clear()
      await Promise.all(
        all.map(async (e) => {
          e.batcher.dispose()
          if (!e.info.exited) await killPty(e)
        }),
      )
    },
  }
}
export type TerminalService = ReturnType<typeof createTerminalService>
