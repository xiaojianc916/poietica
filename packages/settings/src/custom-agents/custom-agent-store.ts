import type {
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
} from '@poietica/native-bridge'

export type {
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
}

export interface CustomAgentStore {
  readonly load: () => Promise<CustomAgentCatalog>
  readonly save: (request: CustomAgentSaveRequest) => Promise<CustomAgentFile>
  readonly remove: (request: CustomAgentRemoveRequest) => Promise<void>
}
