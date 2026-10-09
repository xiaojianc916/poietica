/**
 * 加号面板读的那一份名册（技能 / MCP）。
 *
 * 字段名沿用 legacy 面板那一套（`status` / `lastError`）：组件的分组与详情文案一行不改。
 * 数据从 `conversation.composerToolkitSources` 贡献点来（extensions 提供），在
 * `ui/configuration/composer-toolkit.ts` 的出口映射成这里的形状 —— 面板认识的字只有
 * 这么多，别处（路径、来源过滤、连接细节）不进这一层。
 */

/** 一台 MCP server 此刻在面板里的读法。 */
export type AgentMcpStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

/** 一行技能：面板只画名字与说明。 */
export interface AgentSkill {
  readonly name: string
  readonly description: string
  readonly source: string
}

/** 一台 MCP server：名字即身份（`id` 与 `name` 同值），状态说人话，错误可缺席。 */
export interface AgentMcpServer {
  readonly id: string
  readonly name: string
  readonly status: AgentMcpStatus
  readonly toolCount: number
  readonly lastError?: string | undefined
}

/** 两张表一起读：面板的两个分组各取一张。 */
export type AgentToolkit = Readonly<{
  skills: readonly AgentSkill[]
  mcpServers: readonly AgentMcpServer[]
}>
