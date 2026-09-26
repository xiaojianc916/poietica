/** 按对话读取的技能与 MCP 名册；入口使用锚会话。 */

import type {
  AgentMcpServer as AgentMcpServerDto,
  AgentSkill as AgentSkillDto,
} from '@poietica/contract/conversation'

export type { AgentMcpStatus } from '@poietica/contract/conversation'

/** 名册里的一台 MCP server。传输协议不在此列：屏幕上没有一格画它。 */
export type AgentMcpServer = Readonly<
  Omit<AgentMcpServerDto, 'lastError'> & { lastError?: string | undefined }
>

/** 原生侧交付的一条技能；id 是展示身份，不是文件路径能力。 */
export type AgentSkill = Readonly<AgentSkillDto>

/** 两张表一次问回：它们同属一条连接，分两次问就会有一刻只有一半。 */
export type AgentToolkit = Readonly<{
  skills: readonly AgentSkill[]
  mcpServers: readonly AgentMcpServer[]
}>
