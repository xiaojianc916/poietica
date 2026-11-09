import { statSync } from 'node:fs'
import os from 'node:os'
import { AppError, type Clock, type Logger, systemClock } from '@poietica/foundation'
import { randomEpochBase, StreamChannel } from '@poietica/stream-kit'
import { MAX_TERMINALS, REPLAY_BYTES, type TerminalInfo } from '../contract/entities'
import { terminalErrors } from '../contract/errors'
import { resolveShell, type ShellSpec, terminalEnv } from './shell'

/** 已退出的终端在表里最多留这么久，等 UI 自己来 close（R-08-16）。 */
const EXITED_TTL_MS = 10 * 60_000

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

interface Chunk {
  readonly data: string
  readonly offset: number
}

interface Entry {
  info: TerminalInfo
  pty: Pty
  channel: StreamChannel<Chunk>
  /** 累计输出的末尾，输出通知的起点按它算（R-08-15）。 */
  offset: number
  exitedAt: number | null
}

export interface TerminalServiceDeps {
  readonly spawn: PtyFactory
  readonly logger: Logger
  readonly emitOutput: (p: { terminalId: string; data: string; offset: number; epoch: number; seq: number }) => void
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
  let nextEpoch = randomEpochBase()
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

  /* UI 崩了或漏调 close 时把退出已久的条目顺手收掉，不让重放缓存一直涨。 */
  function sweepExited(): void {
    const now = clock.now()
    for (const [id, e] of entries) {
      const exitedAt = e.exitedAt
      if (exitedAt === null || now - exitedAt <= EXITED_TTL_MS) {
        continue
      }
      entries.delete(id)
      e.channel.dispose()
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
      if (statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true) {
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
      const channel = new StreamChannel<Chunk>(nextEpoch++, () => nextEpoch++, clock, {
        batchWindowMs: 8,
        sizeOf: (items) => items.reduce((sum, item) => sum + item.data.length, 0),
        sink: {
          batch: ({ epoch, seq: batchSeq, items }) => {
            const data = items.map((item) => item.data).join('')
            const first = items[0]
            if (data === '' || first === undefined) return
            d.emitOutput({ terminalId, data, offset: first.offset, epoch, seq: batchSeq })
          },
          reset: () => undefined,
        },
      })
      const entry: Entry = {
        info: { terminalId, cwd, shell: shell.file, title: shell.title, exited: false, exitCode: null },
        pty,
        channel,
        offset: 0,
        exitedAt: null,
      }
      entries.set(terminalId, entry)
      pty.onData((data) => {
        entry.channel.push([{ data, offset: entry.offset }])
        entry.offset += data.length
      })
      pty.onExit(({ exitCode }) => {
        entry.channel.flush()
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
      e.channel.dispose()
      if (!e.info.exited) await killPty(e)
    },
    list(): TerminalInfo[] {
      return [...entries.values()].map((e) => e.info)
    },
    replay(id: string): { data: string; endOffset: number; epoch: number; seq: number } {
      const e = get(id)
      e.channel.flush()
      const { epoch, seq: latest } = e.channel.position()
      const batches = e.channel.catchUp(epoch, 0).batches
      const data = clipReplay(batches.flatMap((batch) => batch.items.map((item) => item.data)).join(''), REPLAY_BYTES)
      return { data, endOffset: e.offset, epoch, seq: latest }
    },
    catchUp(id: string, epoch: number, sinceSeq: number) {
      const e = get(id)
      const result = e.channel.catchUp(epoch, sinceSeq)
      return {
        batches: result.batches.map((batch) => {
          const first = batch.items[0]
          return {
            seq: batch.seq,
            data: batch.items.map((item) => item.data).join(''),
            offset: first?.offset ?? 0,
          }
        }),
        latestSeq: result.latestSeq,
        complete: result.complete,
      }
    },
    async disposeAll(): Promise<void> {
      const all = [...entries.values()]
      entries.clear()
      await Promise.all(
        all.map(async (e) => {
          e.channel.dispose()
          if (!e.info.exited) await killPty(e)
        }),
      )
    },
  }
}

/** 只保留最近 limit 个码元；切点尽量落在换行后，避免重放从半截 ANSI/宽字符开始。 */
function clipReplay(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.length - limit
  const brk = text.indexOf('\n', cut)
  return text.slice(brk === -1 ? cut : brk + 1)
}
