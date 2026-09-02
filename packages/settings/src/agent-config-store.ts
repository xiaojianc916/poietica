import type { AgentProfile } from '@poietica/agent-catalog'

export interface AgentConfigSnapshot {
  /** 这一家 agent 在这台机器上的接入档案。 */
  readonly profile: AgentProfile
  /** 配置文件里被丢弃的坏条目。界面应该显示出来，而不是假装配置是干净的。 */
  readonly issues: readonly string[]
}

/**
 * 这个 agent 的运行时在这台机器上处于什么状态。
 *
 * unmanaged：档案没声明安装方式。
 * unknown：装着，但问不到最新版（离线、镜像不通）——「不知道」不是「该更新」。
 */
type AgentInstallState =
  | 'unmanaged'
  | 'missing'
  | 'outdated'
  | 'current'
  /** 装着，但不是 bun/pnpm/npm 装的 —— 我们不碰别人的安装。 */
  | 'external'
  | 'unknown'

export interface AgentInstallStatus {
  readonly state: AgentInstallState
  readonly installedVersion: string | null
  readonly latestVersion: string | null
  readonly packageName: string | null
}

/**
 * ACP agent 接入配置的持久化端口。
 *
 * 落在独立的 agents.json，不进 AppSettings：agent 接入是设备级的运行环境配置，
 * 跟主题、快捷键这类偏好不是同一种东西，混在一起会让两边的迁移都变难。
 *
 * 模式 B 下，模型与 provider 的权威是 agent 进程自己（它 watch 自己的配置文件并
 * 热重载），读写统一走 kap 的 providers/models REST —— 端口是 ModelCatalogStore，
 * 不在这里。密钥也不在这里：它随一次目录写入交给 agent，写进 agent 自己的配置
 * 文件之后就与我们无关 —— 那份文件里它是明文，所以我们再存一份副本换不到安全，
 * 只换来一个要同步的第二处真相。
 */
export interface AgentSettings {
  readonly load: () => Promise<AgentConfigSnapshot>
  /**
   * 装了没有、是不是最新。
   *
   * 默认读缓存（原生侧 24 小时 TTL），所以界面挂载时调它既不起进程也不走网络。
   * 只有用户明确要求刷新时才传 force。
   */
  readonly loadInstallStatus: (
    agentId: string,
    options?: { readonly force?: boolean },
  ) => Promise<AgentInstallStatus>
  /** 安装或更新这个 agent 的运行时，完成后返回新的状态。 */
  readonly runInstall: (agentId: string) => Promise<AgentInstallStatus>
  /*
   * 「刚才那次调用改了 agent 自己的配置。」
   *
   * 由发起写入的那一方说 —— 只有它知道自己写没写。这是 VS Code
   * onDidChangeConfiguration、Zed SettingsStore::observe_global、TanStack Query
   * invalidateQueries 的同一个形状：失效入口属于 store，不属于某一个组件。
   */
  readonly notifyConfigChanged: () => void
  /** 听「配置变了」。返回退订。 */
  readonly subscribeConfigChanged: (listener: () => void) => () => void
}
