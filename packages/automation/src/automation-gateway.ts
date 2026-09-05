import type {
  AutomationCatalog,
  AutomationCreation,
  AutomationUpdate,
  SchedulePreview,
} from '@poietica/contract/automation'

export interface AutomationGateway {
  readonly loadCatalog: () => Promise<AutomationCatalog>
  readonly create: (creation: AutomationCreation) => Promise<AutomationCatalog>
  readonly update: (update: AutomationUpdate) => Promise<AutomationCatalog>
  readonly enable: (id: string, revision: number, enabled: boolean) => Promise<AutomationCatalog>
  readonly remove: (id: string) => Promise<AutomationCatalog>
  readonly run: (id: string, requestId: string) => Promise<AutomationCatalog>
  readonly cancel: (runId: string) => Promise<AutomationCatalog>
  readonly preview: (schedule: string | null, timeZone: string) => Promise<SchedulePreview>
  readonly watchCatalog: (receive: (catalog: AutomationCatalog) => void) => Promise<() => void>
}
