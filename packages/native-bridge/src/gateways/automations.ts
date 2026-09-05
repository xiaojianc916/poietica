import type { AutomationGateway } from '@poietica/automation'
import { commands, events } from '@poietica/contract'
import { throughIpc } from '../error'

/** One native catalog; failed reads and writes remain errors. */
export const automationGateway: AutomationGateway = {
  loadCatalog: () => throughIpc(() => commands.automationsLoad()),
  create: (creation) => throughIpc(() => commands.automationsCreate(creation)),
  upsert: (automation) => throughIpc(() => commands.automationsUpsert(automation)),
  remove: (id) => throughIpc(() => commands.automationsRemove(id)),
  recordRun: (record) => throughIpc(() => commands.automationsRecordRun(record)),
  watchCatalog: async (onChanged) =>
    events.automationCatalogChanged.listen((event) => {
      onChanged(event.payload.catalog)
    }),
  watchDue: async (onDue) => {
    const unlisten = await events.automationDue.listen((event) => {
      onDue(event.payload.automation)
    })
    try {
      await throughIpc(() => commands.automationsSweep())
      return unlisten
    } catch (cause: unknown) {
      try {
        unlisten()
      } catch (cleanup: unknown) {
        throw new AggregateError(
          [cause, cleanup],
          'Automation subscription startup and cleanup failed.',
        )
      }
      throw cause
    }
  },
}
