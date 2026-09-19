import { commands, type JsonValue } from '@poietica/contract'
import type { AgentConfigurationRepository } from '@poietica/settings'
import { throughIpc } from '../ipc-error'
export function createAgentConfigBridge(): AgentConfigurationRepository {
  return {
    load: () => throughIpc(() => commands.agentConfigGet()),

    /*
     * agents 是不透明 JSON —— Rust 侧把它声明成 JsonValue 就是这个意思。校验不在这一层：
     * packages/settings 的 agent-runtime 用 @poietica/agent-catalog 的 resolveAgentProfile
     * 认它，认不出的当场说。这里只做类型断言，不外泄给任何调用方。
     */
    saveAgents: (agents, defaultAgentId) =>
      throughIpc(() => commands.agentConfigSaveAgents(agents as JsonValue[], defaultAgentId)),

    loadInstallStatus: (agentId, force) =>
      throughIpc(() => commands.agentInstallStatus(agentId, force)),

    runInstall: (agentId) => throughIpc(() => commands.agentInstallRun(agentId)),
  }
}
