import type { Logger } from '@poietica/foundation'
import { builtinPoints } from '../builtin-points'
import type { ContributionRegistry } from '../contribution'
import type { ToastService } from './toasts'

export interface CommandService {
  execute(id: string, args?: unknown): Promise<void>
  isEnabled(id: string): boolean
}

export function createCommandService(
  registry: ContributionRegistry,
  toasts: ToastService,
  logger: Logger,
): CommandService {
  const find = (id: string) => registry.list(builtinPoints.commands).find((c) => c.item.id === id)?.item
  return {
    isEnabled: (id) => {
      const c = find(id)
      return c !== undefined && (c.enabled?.() ?? true)
    },
    async execute(id, args) {
      const c = find(id)
      if (c === undefined) {
        logger.warn('unknown command', { id })
        return
      }
      if (!(c.enabled?.() ?? true)) return
      try {
        await c.run(args)
      } catch (e) {
        logger.error('command failed', { id, error: String(e) })
        toasts.error(e, `命令“${c.title}”执行失败`)
      }
    },
  }
}
