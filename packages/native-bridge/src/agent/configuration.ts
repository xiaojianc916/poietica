import { commands, type JsonValue } from '@poietica/contract'
import type { AgentConfigurationRepository } from '@poietica/settings'
import { throughIpc } from '../ipc-error'
export function createAgentConfigBridge(): AgentConfigurationRepository {
  return {
    load: () => throughIpc(() => commands.agentConfigGet()),

    /*
     * agents 是不透明 JSON —— Rust 侧把它声明成 JsonValue 就是这个意思，校验在
     * @poietica/agent-catalog。断言只发生在这一行，不外泄给任何调用方。
     */
    saveAgents: (agents, defaultAgentId) =>
      throughIpc(() => commands.agentConfigSaveAgents(agents as JsonValue[], defaultAgentId)),

    loadInstallStatus: (agentId, force) =>
      throughIpc(() => commands.agentInstallStatus(agentId, force)),

    runInstall: (agentId) => throughIpc(() => commands.agentInstallRun(agentId)),
  }
}
