/**
 * 加号面板读的那一份名册（技能 / MCP）：数据从 `conversation.composerToolkitSources` 贡献点来，在
 * `ui/composer/toolkit.ts` 的出口映射成这里的形状 —— 面板认识的字只有这么多，路径与连接细节不进这一层。
 * 字段名沿用面板那一套（`status` / `lastError`），组件的分组与详情文案一行不改。
 */

export type AgentMcpStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

export interface AgentSkill {
  readonly name: string
  readonly description: string
  readonly source: string
}

/** 名字即身份：`id` 与 `name` 同值。 */
export interface AgentMcpServer {
  readonly id: string
  readonly name: string
  readonly status: AgentMcpStatus
  readonly toolCount: number
  readonly lastError?: string | undefined
}

export type AgentToolkit = Readonly<{
  skills: readonly AgentSkill[]
  mcpServers: readonly AgentMcpServer[]
}>
