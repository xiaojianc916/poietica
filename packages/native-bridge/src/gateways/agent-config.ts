import {
  type AgentConfigSnapshot,
  type AgentInstallStatus,
  commands,
  type JsonValue,
} from '@poietica/contract'
import { throughIpc } from '../error'

/*
 * 线上的形状只有一份，它在生成绑定里。
 *
 * 这个文件此前手抄了三份：AgentCliRequest、AgentCliResult、AgentConfigSnapshot ——
 * 而 export_bindings.rs 的文件头逐字写着 renderer code must not redefine native DTOs。
 */
export type { AgentConfigSnapshot, AgentInstallStatus }

/*
 * 安装那条路用 single-flight：用户会连点，而每一次点都是一个 npm 进程。同一把
 * 钥匙上已经在飞的那次直接复用 —— 这是 single-flight，不是节流：调用方拿到的
 * 仍然是真实那一次的结果。
 */
const flights = new Map<string, Promise<AgentInstallStatus>>()

function singleFlight(
  key: string,
  work: () => Promise<AgentInstallStatus>,
): Promise<AgentInstallStatus> {
  const flying = flights.get(key)

  if (flying !== undefined) {
    return flying
  }

  const started = work().finally(() => {
    flights.delete(key)
  })

  flights.set(key, started)

  return started
}

export interface AgentConfigBridge {
  readonly load: () => Promise<AgentConfigSnapshot>
  readonly saveAgents: (
    agents: readonly unknown[],
    defaultAgentId: string,
  ) => Promise<AgentConfigSnapshot>
  /**
   * 这个 agent 的运行时装了没有、是不是最新。
   *
   * force 为假时命中原生侧 24 小时内的缓存，既不起进程也不走网络，界面可以随便调。
   */
  readonly loadInstallStatus: (agentId: string, force: boolean) => Promise<AgentInstallStatus>
  /** 安装或更新这个 agent 的运行时，完成后返回新的状态。 */
  readonly runInstall: (agentId: string) => Promise<AgentInstallStatus>
}

export function createAgentConfigBridge(): AgentConfigBridge {
  return {
    load: () => throughIpc(() => commands.agentConfigGet()),

    /*
     * agents 是不透明 JSON —— Rust 侧把它声明成 JsonValue 就是这个意思，校验在
     * @poietica/agent-catalog。断言只发生在这一行，不外泄给任何调用方。
     */
    saveAgents: (agents, defaultAgentId) =>
      throughIpc(() => commands.agentConfigSaveAgents(agents as JsonValue[], defaultAgentId)),

    loadInstallStatus: (agentId, force) =>
      singleFlight(`status:${agentId}:${String(force)}`, () =>
        throughIpc(() => commands.agentInstallStatus(agentId, force)),
      ),

    runInstall: (agentId) =>
      singleFlight(`install:${agentId}`, () => throughIpc(() => commands.agentInstallRun(agentId))),
  }
}
