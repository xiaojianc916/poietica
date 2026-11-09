// omp 的公开类型出口：只有 `export type`，编译后不留下任何运行时代码。
// 业务与界面从这里拿 omp 的类型；实现仍然只能在 engine-omp 里 import。

export type {
  AgentEvent as OmpAgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
} from '@oh-my-pi/pi-agent-core'
export type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@oh-my-pi/pi-ai'
export type {
  AgentSession,
  CompactionEntry,
  CustomMessage,
  GoalModeState,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionManager,
  SessionMessageEntry,
  TodoItem,
  ToolDefinition,
  UsageStatistics,
} from '@oh-my-pi/pi-coding-agent'
export type { AgentSessionEvent } from '@oh-my-pi/pi-coding-agent/session/agent-session-events'

// 工具载荷：按工具名各有其形，界面不再猜字段（见 tools.ts）。
export type {
  OmpEditToolInput,
  OmpEvalCellResult,
  OmpEvalDetails,
  OmpEvalStatusEvent,
  OmpEvalToolInput,
  OmpFetchToolInput,
  OmpGenericToolDetails,
  OmpGenericToolInput,
  OmpGenericToolOutput,
  OmpMcpToolDetails,
  OmpNoToolInput,
  OmpOpaqueToolDetails,
  OmpTodoItem,
  OmpTodoPhase,
  OmpToolAsyncJob,
  OmpToolContentBlock,
  OmpToolDetailBase,
  OmpToolDetails,
  OmpToolDetailsOf,
  OmpToolInput,
  OmpToolInputOf,
  OmpToolName,
  OmpToolOutput,
  OmpToolOutputOf,
} from './tools'
