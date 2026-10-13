import type { Logger } from '@poietica/foundation'
import type { UiLogEntry } from '../contract/entities'

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
