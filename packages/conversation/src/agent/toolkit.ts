/** 按对话读取的技能与 MCP 名册；入口使用锚会话。 */

export type AgentMcpStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

/** 名册里的一台 MCP server。传输协议不在此列：屏幕上没有一格画它。 */
export interface AgentMcpServer {
  readonly id: string
  readonly name: string
  readonly status: AgentMcpStatus
  readonly toolCount: number
  /** 这台此刻为什么不可用。status 为 error 之外的档位没有它。 */
  readonly lastError?: string | undefined
}

/** 原生侧交付的一条技能；id 是展示身份，不是文件路径能力。 */
export interface AgentSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: string
  readonly path: string
  readonly project: string | null
  readonly projectPath: string | null
  readonly document: string | null
  readonly directory: string | null
  readonly enabled: boolean
  readonly loaded: boolean
  readonly kind: string | null
  readonly disableModelInvocation: boolean | null
  readonly supportingFiles: number | null
  readonly totalBytes: number | null
  readonly modifiedAt: number | null
}

/** 两张表一次问回：它们同属一条连接，分两次问就会有一刻只有一半。 */
export interface AgentToolkit {
  readonly skills: readonly AgentSkill[]
  readonly mcpServers: readonly AgentMcpServer[]
}
