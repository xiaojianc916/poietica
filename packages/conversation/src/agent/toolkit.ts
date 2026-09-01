/*
 * 这条连接此刻公布的技能与 MCP 名册。
 *
 * 它属于 agent 进程，不属于任何一条对话：技能目录由 agent 合并它自己的几层目录
 * 得出，MCP 名册是它自己的连接状态。入口那一格没有对话也没有会话，而两者在那里
 * 都必须画得出来，所以这个端口不认识 threadId —— 不是省略，是它问不出那种问题。
 */

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
