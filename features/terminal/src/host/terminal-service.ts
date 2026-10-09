import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import { AppError, type Clock, type Logger, systemClock } from '@poietica/foundation'
import { MAX_TERMINALS, REPLAY_BYTES, type TerminalInfo } from '../contract/entities'
import { terminalErrors } from '../contract/errors'
import { createOutputBatcher } from './output-batcher'
import { RingBuffer } from './ring-buffer'
import { resolveShell, type ShellSpec, terminalEnv } from './shell'

/** 已退出的终端在表里最多留这么久，等 UI 自己来 close（R-08-16） */
const EXITED_TTL_MS = 10 * 60_000

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
  /** 累计输出长度：replay 的末尾与输出通知的起点都按它算（R-08-15） */
  offset: number
  /** 退出时刻；还在跑时为 null（R-08-16） */
  exitedAt: number | null
}

export interface TerminalServiceDeps {
  readonly spawn: PtyFactory
  readonly logger: Logger
  /** offset = data 首码元在累计输出里的位置（R-08-15） */
  readonly emitOutput: (terminalId: string, data: string, offset: number) => void
  readonly emitExited: (terminalId: string, exitCode: number | null) => void
  readonly env?: NodeJS.ProcessEnv
  readonly killTree?: (pid: number) => Promise<void>
  readonly clock?: Clock
}

export function createTerminalService(d: TerminalServiceDeps) {
  const env = d.env ?? process.env
  const clock = d.clock ?? systemClock
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

  /* R-08-16：UI 崩了或漏调 close 时把退出已久的条目顺手收掉，不让重放缓存一直涨。 */
  function sweepExited(): void {
    const now = clock.now()
    for (const [id, e] of entries) {
      const exitedAt = e.exitedAt
      if (exitedAt === null || now - exitedAt <= EXITED_TTL_MS) {
        continue
      }
      entries.delete(id)
      e.batcher.dispose()
      d.logger.info('terminal entry reaped', { terminalId: id })
    }
  }

  return {
    async open(p: { cwd: string | null; cols: number; rows: number }): Promise<TerminalInfo> {
      sweepExited()
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
        batcher: createOutputBatcher((data, offset) => d.emitOutput(terminalId, data, offset)),
        offset: 0,
        exitedAt: null,
      }
      entries.set(terminalId, entry)
      pty.onData((data) => {
        entry.replay.push(data)
        entry.offset += data.length
        entry.batcher.push(data)
      })
      pty.onExit(({ exitCode }) => {
        entry.batcher.drain()
        entry.info = { ...entry.info, exited: true, exitCode }
        entry.exitedAt = clock.now()
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
    /** 重放数据 + 它在累计输出里的末尾位置（R-08-15） */
    replay(id: string): { data: string; endOffset: number } {
      const e = get(id)
      return { data: e.replay.read(), endOffset: e.offset }
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
