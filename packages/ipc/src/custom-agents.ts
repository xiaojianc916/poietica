import { throughIpc } from './error'
import type {
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
} from './generated/ipc-bindings'
import { commands } from './generated/ipc-bindings'

export type {
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
} from './generated/ipc-bindings'

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
