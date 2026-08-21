export type AgentMcpTransport = 'stdio' | 'http' | 'sse'
export type AgentMcpStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

/** Kimi GET /mcp/servers 返回的一条 server。 */
export interface AgentMcpServer {
  readonly id: string
  readonly name: string
  readonly transport: AgentMcpTransport
  readonly status: AgentMcpStatus
  readonly toolCount: number
  readonly lastError?: string | undefined
}

/** 名册属于当前 Kimi 进程，不属于某一轮 prompt。 */
export interface AgentMcpPort {
  readonly list: () => Promise<readonly AgentMcpServer[]>
}
