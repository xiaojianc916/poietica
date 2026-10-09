import { defineContributionPoint } from '@poietica/ui-kernel'

/*
 * 输入框加号面板里「技能 / MCP」两组的数据落点。
 *
 * 07 页 §5E 迁移时漏了这件事：面板的显隐由 `skills.length > 0` / `mcpServers.length > 0`
 * 决定，而名册从哪来没有写。名册属于 extensions（它持有 `skills.list` / `mcp.status` /
 * `mcp.statusChanged`），conversation 的契约再转发一份就是两个主人，所以按守则 3 走
 * 贡献点：谁认识名册谁来提供，与 attachments 的 `composerProviders`、review 的
 * `workspaceGitProviders` 同一形制。
 *
 * 数据按**工作区**寻址：技能分层按工作目录（omp 的 discoverSkills(cwd)），换项目换名册。
 * MCP 是全局的一份（配置文件只有用户级），提供方自己在各工作区缓存里共用同一次读。
 *
 * `ensure` 与 `read` 分开是这一点的关键：`read` 在渲染期被调用（useSyncExternalStore
 * 的 getSnapshot），必须**纯**且引用稳定；真正发起读取的副作用只能落在 `ensure` 里。
 * 调用方在 effect 里 ensure、在订阅里等变化。
 */

/** 面板里一行的技能：名字、说明、来源。别的格子（路径、目录、启用态）面板不画。 */
export interface ToolkitSkill {
  readonly name: string
  readonly description: string
  readonly source: 'user' | 'project'
}

/**
 * 面板里一行的 MCP server。
 *
 * 四档就是面板那四句话的判据：已连接 / 连接中 / 未连接 / 起不来。**名单**来自配置
 * （`mcp.list`），状态来自活会话（`mcp.status`）—— 没连上的（含还没跑过会话、以及被
 * 停用的）一律 `disconnected`：面板只说「这一句用不上它」，启用与否归设置页说。
 */
export interface ToolkitMcpServer {
  readonly name: string
  readonly state: 'connecting' | 'connected' | 'disconnected' | 'failed'
  readonly toolCount: number
  readonly error: string | null
}

export interface ComposerToolkit {
  readonly skills: readonly ToolkitSkill[]
  readonly mcpServers: readonly ToolkitMcpServer[]
}

/** 没有提供者、或提供者还没读到东西时的那一份。引用终生不变，消费者可以拿它做相等判据。 */
export const EMPTY_TOOLKIT: ComposerToolkit = Object.freeze({ skills: [], mcpServers: [] })

export interface ComposerToolkitSource {
  readonly id: string
  /** 输入框挂载、或工作区变了时调用：没缓存就开始加载；已经有就什么都不做。 */
  ensure(workspaceId: string | null): void
  /**
   * 纯读取。数据没变时必须返回同一个对象 —— 它喂给 useSyncExternalStore 的 getSnapshot，
   * 每次新造一个会让订阅者一路重渲染。
   */
  read(workspaceId: string | null): ComposerToolkit
  subscribe(listener: () => void): () => void
}

export const composerToolkitSources = defineContributionPoint<ComposerToolkitSource>(
  'conversation.composerToolkitSources',
)
