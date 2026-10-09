import type { CoreModuleContext } from '@poietica/core-kernel'
import type { automationsContract } from '../contract'
import type { AutomationsService } from './service'

export function registerHandlers(
  ctx: CoreModuleContext<typeof automationsContract>,
  service: AutomationsService,
): void {
  const changed = (): void => {
    ctx.rpc.emit('automations.changed', {})
  }

  ctx.rpc.handle('automations.list', () => ({ automations: service.list() }))
  ctx.rpc.handle('automations.get', (p) => service.get(p.automationId))
  ctx.rpc.handle('automations.create', (p) => {
    const created = service.create(p)
    changed()
    return created
  })
  ctx.rpc.handle('automations.update', (p) => {
    const updated = service.update(p.automationId, p.patch)
    changed()
    return updated
  })
  ctx.rpc.handle('automations.remove', async (p) => {
    await service.remove(p.automationId)
    changed()
    return {}
  })
  ctx.rpc.handle('automations.setEnabled', (p) => {
    const updated = service.setEnabled(p.automationId, p.enabled)
    changed()
    return updated
  })
  ctx.rpc.handle('automations.runNow', async (p) => {
    const run = await service.runNow(p.automationId)
    changed()
    return run
  })
  ctx.rpc.handle('automations.cancelRun', async (p) => {
    await service.cancel(p.runId)
    changed()
    return {}
  })
  ctx.rpc.handle('automations.runs', (p) => ({ runs: service.runs(p.automationId, p.limit) }))
  ctx.rpc.handle('automations.previewSchedule', (p) => service.previewSchedule(p.schedule, p.count))
}
