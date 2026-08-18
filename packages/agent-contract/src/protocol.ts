/**
 * The ACP session vocabulary, re-exported from the official SDK.
 *
 * The Acp prefix marks a name as the protocol's rather than this product's —
 * the distinction run.ts is built on. The types behind it are upstream's, so
 * they cannot drift.
 */

export type {
  AvailableCommand as AcpAvailableCommand,
  EmbeddedResourceResource as AcpEmbeddedResource,
  PermissionOption as AcpPermissionOption,
  PlanEntry as AcpPlanEntry,
  PlanEntryPriority as AcpPlanEntryPriority,
  PlanEntryStatus as AcpPlanEntryStatus,
  SessionId as AcpSessionId,
  ToolCallContent as AcpToolCallContent,
  ToolCallId as AcpToolCallId,
  ToolCallLocation as AcpToolCallLocation,
  ToolCallStatus as AcpToolCallStatus,
  ToolCallUpdate as AcpToolCallUpdate,
  ToolKind as AcpToolKind,
} from '@agentclientprotocol/sdk'
