import type { Logger } from '@poietica/foundation'
import type { UiLogEntry } from '../contract/entities'

/** 把 UI 批量日志落到主日志：每条用 `logger.child({proc:'ui', scope})` 写 */
export function createLogSink(logger: Logger): { write(entries: readonly UiLogEntry[]): void } {
  return {
    write(entries) {
      for (const entry of entries) {
        const scoped = logger.child({ proc: 'ui', scope: entry.scope })
        scoped[entry.level](entry.message, entry.data)
      }
    },
  }
}
