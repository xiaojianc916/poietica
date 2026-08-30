import type { McpEndpoint } from '@poietica/contract'
import { commands } from '@poietica/contract'
import { throughIpc } from '../error'

export type { McpEndpoint } from '@poietica/contract'

/**
 * 本进程那台 MCP 服务器听在哪儿。
 *
 * null 表示它没能绑上回环端口。那不是一个需要中断什么的错误 —— 少一台服务器而已，
 * 界面照样把这一行显示出来并说明原因，比静默消失诚实。
 */
export function readMcpEndpoint(): Promise<McpEndpoint | null> {
  return throughIpc(() => commands.mcpEndpoint())
}
