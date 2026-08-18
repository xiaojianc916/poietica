import { parseKapAgentProfileSet, reconcileKapAgentProfiles } from '@poietica/agent-catalog'
import {
  type AgentConfigSnapshot as AgentConfigSnapshotDto,
  createAgentConfigBridge,
} from '@poietica/ipc'
import type { AgentConfigSnapshot, AgentConfigStore } from '@poietica/settings'

/*
 * agent 接入配置在桌面端的存储。
 *
 * 边界上有一处真实的翻译：Rust 侧把 agents 当不透明对象原样存取，生成出来是
 * unknown[]，而端口说的是 AgentProfile[]。校验只能落在这里 —— agents.json
 * 可以被手改，一个被改坏的档案不应该变成一次任意命令执行。
 *
 * parseKapAgentProfileSet 是容错的：坏条目被丢弃并记一条 issue，不会让整份配置
 * 解析失败。它产生的 issues 与 Rust 侧报回的 issues 合并后一起交给界面，因为两者
 * 都是「配置里有东西没能用上」，没有理由只显示其中一半。
 */
export function createDesktopAgentConfigStore(): AgentConfigStore {
  const bridge = createAgentConfigBridge()

  /*
   * 「agent 自己的配置被改过了」的听众。
   *
   * 存在这里而不是某个模块级单例：这个 store 一个进程一份，由组合根建起来并同时
   * 交给设置页和助手那一路（AppShell 的 runtime.agentConfig）—— 通道的作用域就该
   * 是它的作用域，多一个全局变量只会多一处生命周期不明的状态。
   */
  const listeners = new Set<() => void>()

  return {
    async load() {
      const dto = await bridge.load()
      const parsed = parseKapAgentProfileSet({
        profiles: dto.agents,
        defaultProfileId: dto.defaultAgentId,
      })
      const reconciled = reconcileKapAgentProfiles(parsed.value.profiles)

      /*
       * 内置档案的身份由二进制拥有，agents.json 只是它的一份物化 —— 所以每次读都重新
       * 物化。上一版只在文件为空时写一次，那份拷贝因此停在用户第一次启动的那个版本：
       * 后来加进档案的 registryKeyVar 到不了磁盘，设置页就说这个 agent 没有声明该往
       * 哪个环境变量注入密钥。首次落盘不再是一条特例分支，它就是「空名单的物化结果与
       * 磁盘不一致」这同一件事。
       *
       * 只有在没有任何条目被丢弃时才写回：一份被手改坏的档案解析后会少条目，写回去等于
       * 替用户删文件。这时物化只活在内存里（界面照样能用），并把 issue 照实说出去。
       * 文件本来就空则不存在这个风险。
       */
      const writable = dto.agents.length === 0 || parsed.issues.length === 0

      /*
       * 光看 reconciled.changed 是不够的，而且在最要紧的那一次上恰好是错的。
       *
       * 磁盘为空时 parseKapAgentProfileSet 已经把内置档案顶上来了，reconcile 于是
       * 拿内置跟内置比：sameLaunchIdentity 恒真、missing 为空、changed 为 false ——
       * 首次启动一个字都不写。渲染层用着内存里那份照常显示，原生层读磁盘只读到空
       * 文件，屏幕上就是「没有可用的 agent 档案」加「agents.json 里没有 kimi 的接入
       * 档案」：同一个缺失，被两层用各自的说法讲了两遍。
       *
       * parsed.fallback 说的正是「这份 value 是编出来的，磁盘上还没有」。它与
       * changed 是两个不同的问题，缺一个都会漏掉一整类情形。
       *
       * writable 那道闸继续管它原来的事：一份被手改坏的档案解析后会少条目，写回去
       * 等于替用户删文件。磁盘本来就空则不存在这个风险。
       */
      if ((parsed.fallback || reconciled.changed) && writable) {
        const written = fromDto(
          await bridge.saveAgents(reconciled.profiles, parsed.value.defaultProfileId),
        )

        /*
         * 物化自己产生的说明要一起交出去。
         *
         * 它说的是「磁盘上有一条不在名单里的 agent，我把它删了」—— 这条话只在这
         * 一次读取里存在：写回之后再读，那一行已经不在文件里，谁也不会再提起它。
         * 不带上就是替用户改了文件而一声不吭。
         */
        return { ...written, issues: [...written.issues, ...reconciled.issues] }
      }

      return {
        agents: reconciled.profiles,
        defaultAgentId: parsed.value.defaultProfileId,
        issues: [...dto.issues, ...parsed.issues, ...reconciled.issues],
      }
    },

    async saveAgents({ agents, defaultAgentId }) {
      return fromDto(await bridge.saveAgents(agents, defaultAgentId))
    },

    /* 请求与结果两侧同名同类型，没有可翻译的东西，翻一遍只会多一个出错的地方。 */
    execCli(invocation) {
      return bridge.execCli(invocation)
    },

    loadKeyTails: (agentId) => bridge.loadKeyTails(agentId),

    loadDefaultModel: (agentId) => bridge.loadDefaultModel(agentId),

    saveDefaultModel: (agentId, alias) => bridge.saveDefaultModel(agentId, alias),

    /* 原生 DTO 与端口的形状逐格相同，翻一遍只会多一个出错的地方。 */
    loadInstallStatus: (agentId, options) =>
      bridge.loadInstallStatus(agentId, options?.force ?? false),

    runInstall: (agentId) => bridge.runInstall(agentId),

    verifyProviderKey: ({ baseUrl, secret }) => bridge.verifyProviderKey(baseUrl, secret),

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

function fromDto(dto: AgentConfigSnapshotDto): AgentConfigSnapshot {
  const parsed = parseKapAgentProfileSet({
    profiles: dto.agents,
    defaultProfileId: dto.defaultAgentId,
  })

  return {
    agents: parsed.value.profiles,
    defaultAgentId: parsed.value.defaultProfileId,
    issues: [...dto.issues, ...parsed.issues],
  }
}
