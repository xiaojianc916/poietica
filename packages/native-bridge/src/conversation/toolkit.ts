import { type AgentMcpServer, commands } from '@poietica/contract'
import type { AgentCapabilityPort } from '@poietica/conversation'
import { throughIpc } from '../ipc-error'
import type { AgentBridgeOptions } from './launch-contract'

export function createAgentToolkitReader({
  launch,
  cwd,
}: AgentBridgeOptions): AgentCapabilityPort['readToolkit'] {
  return async (threadId) => {
    const listed = await throughIpc(async () =>
      commands.agentToolkit({ launch: await launch(), cwd: cwd?.() ?? null, threadId }),
    )

    return {
      skills: listed.skills,
      mcpServers: listed.mcpServers.map((server: AgentMcpServer) => ({
        id: server.id,
        name: server.name,
        status: server.status,
        toolCount: server.toolCount,
        ...(server.lastError === null ? {} : { lastError: server.lastError }),
      })),
    }
  }
}
