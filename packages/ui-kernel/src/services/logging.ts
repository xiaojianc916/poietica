/*
 * 渲染进程的日志 sink：把内核日志写进 devtools console（真正落盘由 platform 的 log.write 完成）。
 * console 是渲染层唯一可用的输出通道，这个文件在 biome.json 里按精确路径豁免 noConsole。
 */
import type { Logger } from '@poietica/foundation'

export interface UiLogEntry {
  readonly ts: number
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly scope: string
  readonly message: string
  readonly data?: Record<string, unknown>
}
export interface UiLogging {
  readonly logger: Logger
  /** platform 的 ui 功能在 setup 时接上 log.write；接上之前的日志先缓存（最多 500 条） */
  setSink(sink: (entries: readonly UiLogEntry[]) => void): void
}
const BUFFER_MAX = 500
const FLUSH_MS = 1_000

export function createUiLogging(): UiLogging {
  let sink: ((entries: readonly UiLogEntry[]) => void) | undefined
  let buffer: UiLogEntry[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    timer = undefined
    if (sink === undefined || buffer.length === 0) return
    const batch = buffer
    buffer = []
    sink(batch)
  }
  const write = (
    level: UiLogEntry['level'],
    bindings: Record<string, unknown>,
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    const scope = String(bindings.feature ?? bindings.scope ?? 'ui')
    buffer.push({ ts: Date.now(), level, scope, message, ...(data === undefined ? {} : { data }) })
    if (buffer.length > BUFFER_MAX) buffer = buffer.slice(-BUFFER_MAX)
    if (level === 'error' || level === 'warn') console[level](`[${scope}] ${message}`, data ?? '')
    if (timer === undefined) timer = setTimeout(flush, FLUSH_MS)
  }
  const make = (bindings: Record<string, unknown>): Logger => ({
    debug: (m, d) => write('debug', bindings, m, d),
    info: (m, d) => write('info', bindings, m, d),
    warn: (m, d) => write('warn', bindings, m, d),
    error: (m, d) => write('error', bindings, m, d),
    child: (b) => make({ ...bindings, ...b }),
  })
  return {
    logger: make({}),
    setSink: (s) => {
      sink = s
      flush()
    },
  }
}
