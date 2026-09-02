import { agent, resolveAgentProfile } from '@poietica/agent-catalog'
import type { AgentConfigSnapshot, AgentSettings } from '@poietica/settings'
import { createAgentConfigBridge } from './agent-config'

/*
 * agent 接入配置在桌面端的存储。
 *
 * 边界上有一处真实的翻译：Rust 侧把 agents 当不透明数组原样存取，而端口说的是这一家
 * agent 的档案。校验只能落在这里 —— agents.json 可以被手改，一个被改坏的档案不应该
 * 变成一次任意命令执行。怎么算由 resolveAgentProfile 说，这一层只负责读写。
 */
export function createAgentSettings(): AgentSettings {
  const bridge = createAgentConfigBridge()

  /*
   * 「agent 自己的配置被改过了」的听众。存在这里而不是模块级单例：这个 store 一个
   * 进程一份，通道的作用域就该是它的作用域。
   */
  const listeners = new Set<() => void>()

  return {
    async load(): Promise<AgentConfigSnapshot> {
      const dto = await bridge.load()
      const resolved = resolveAgentProfile(dto.agents)

      /*
       * 档案的身份由二进制拥有，agents.json 只是它的一份物化 —— 所以每次读都重新
       * 物化。物化自己产生的说明要一起交出去：写回之后再读，那一行已经不在文件里。
       */
      if (resolved.materialize) {
        const written = await bridge.saveAgents([resolved.profile], agent.id)

        return { profile: resolved.profile, issues: [...written.issues, ...resolved.issues] }
      }

      return { profile: resolved.profile, issues: [...dto.issues, ...resolved.issues] }
    },

    loadInstallStatus: (agentId, options) =>
      bridge.loadInstallStatus(agentId, options?.force ?? false),

    runInstall: (agentId) => bridge.runInstall(agentId),

    notifyConfigChanged() {
      for (const listener of listeners) {
        listener()
      }
    },

    subscribeConfigChanged(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}
