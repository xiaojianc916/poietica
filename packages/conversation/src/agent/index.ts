/**
 * agent 会话的端口与线上词汇：对话领域声明它需要宿主提供哪些动作、kap 帧
 * 在投影之前的最小前提。实现的唯一住所在 @poietica/native-bridge，由组合根
 * 注入 store —— 本模块只有类型。
 *
 * 逐条列名而不是整模块转出：外面看得见什么由这个文件说了算。改名与删除因此
 * 在这里就看得见。
 */

export type { AgentCapabilityPort } from './capability'
export type {
  SessionConfigChoice,
  SessionConfigControl,
  SessionConfigPort,
  SessionConfigPurpose,
  SessionConfigReport,
} from './config'
export type { SessionGoal, SessionGoalStatus } from './goal'
export type { KapEventPayload, KapSessionId, KapStopReason, KapToolCallId } from './kap'
export type { SessionLink } from './link'
export type {
  ApprovalAnswer,
  ApprovalDecision,
  ApprovalScope,
  PermissionPosturePort,
} from './permission'
export type {
  QuestionAnswer,
  QuestionAnswerMethod,
  QuestionChoice,
  QuestionItem,
  QuestionOption,
  QuestionResponse,
} from './question'
export type {
  ChatStatus,
  QuestionOutcome,
  RunEvent,
  RunStatus,
} from './run'
export type {
  AgentPromptHandle,
  AgentPromptRequest,
  AgentSessionPort,
  PromptAsset,
  PromptConfiguration,
  PromptSkill,
} from './session'
export type {
  FrameCursor,
  FramePage,
  OpenedThread,
  ThreadHistory,
  ThreadPort,
  ThreadRecord,
  ThreadSnapshot,
  TurnMark,
} from './thread'
export type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from './tool-call'
export type { AgentMcpServer, AgentMcpStatus, AgentSkill, AgentToolkit } from './toolkit'
export type { SessionUsage, SessionUsagePort, SessionUsageReport } from './usage'
