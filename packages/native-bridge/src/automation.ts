import type { AutomationGateway } from '@poietica/automation'
import { commands, events } from '@poietica/contract'
import { throughIpc } from './ipc-error'

export const automationGateway: AutomationGateway = {
  loadCatalog: () => throughIpc(() => commands.automationsLoad()),
  create: (creation) => throughIpc(() => commands.automationsCreate(creation)),
  update: (update) => throughIpc(() => commands.automationsUpdate(update)),
  enable: (id, revision, enabled) =>
    throughIpc(() => commands.automationsEnable(id, revision, enabled)),
  remove: (id) => throughIpc(() => commands.automationsRemove(id)),
  run: (id, requestId) => throughIpc(() => commands.automationsRun(id, requestId)),
  cancel: (runId) => throughIpc(() => commands.automationsCancel(runId)),
  preview: (schedule, timeZone) =>
    throughIpc(() => commands.automationsPreview(schedule, timeZone)),
  watchCatalog: (receive) =>
    events.automationCatalogChanged.listen((event) => receive(event.payload.catalog)),
}
