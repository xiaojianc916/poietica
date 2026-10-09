import { jsonlFileSink } from '@poietica/logging'

export interface CoreLogSink {
  line(text: string): void
  stray(text: string): void
}

export function createCoreLogSink(o: { file: string }): CoreLogSink {
  const sink = jsonlFileSink({ file: o.file, maxBytes: 5 * 1024 * 1024, keep: 3 })
  return {
    line(text) {
      const trimmed = text.trim()
      if (trimmed === '') return
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (typeof parsed === 'object' && parsed !== null) {
          sink.write(parsed as Record<string, unknown>)
          return
        }
      } catch {
        /* 非 JSON 行，走下面的包装 */
      }
      sink.write({ ts: Date.now(), level: 'info', proc: 'core', scope: 'core-stderr', msg: trimmed })
    },
    stray(text) {
      sink.write({ ts: Date.now(), level: 'warn', proc: 'core', scope: 'stray', msg: text.slice(0, 2_000) })
    },
  }
}
