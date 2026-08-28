import type {
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
} from '@poietica/contract'
import { commands } from '@poietica/contract'
import { throughIpc } from './error'

export type {
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
} from '@poietica/contract'

export function listCustomAgents(): Promise<CustomAgentCatalog> {
  return throughIpc(() => commands.customAgentsList())
}

export function saveCustomAgent(request: CustomAgentSaveRequest): Promise<CustomAgentFile> {
  return throughIpc(() => commands.customAgentsSave(request))
}

export function removeCustomAgent(request: CustomAgentRemoveRequest): Promise<void> {
  return throughIpc(async () => {
    await commands.customAgentsRemove(request)
  })
}
