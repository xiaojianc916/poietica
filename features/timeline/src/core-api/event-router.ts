import type { AgentEvent } from '@poietica/agent-model'
import { defineServiceToken } from '@poietica/foundation'
import type { ControlsSnapshot, QueueView, Thread } from '@poietica/product-model'
import type {
  CommandOutputTone,
  ContextUsage,
  Controls,
  EngineSessionEvent,
  FileChange,
  Interaction,
  Posture,
  UsageSample,
} from '@poietica/runtime-protocol'
import type { TimelineEventsNotice, TimelineService } from './service'

export interface SideDelta {
  readonly threadId: string
  readonly topicId: string
  readonly turn: number
  readonly offset: number
  readonly delta: string
}

export interface RouterThreadRow {
  readonly posture: Posture
  readonly updatedAt: number
}

export interface RouterThreadsPort {
  threadOf(row: RouterThreadRow): Thread
  setPosture(threadId: string, posture: Posture): void
  setTitleFromSession(threadId: string, title: string, source: 'auto' | 'user', sessionFile: string): void
}

export interface RouterRepositoryPort {
  get(threadId: string): RouterThreadRow | null
  update(threadId: string, patch: { updatedAt: number }): void
  controlsSnapshot(threadId: string): ControlsSnapshot | null
  saveControlsSnapshot(threadId: string, snapshot: ControlsSnapshot): void
}

export interface RouterJournalPort {
  appendAndStamp(threadId: string, agentId: string, events: readonly AgentEvent[]): readonly AgentEvent[]
}

export interface RouterSubmissionsPort {
  claimPendingTurn(threadId: string): string | null
  clientTurnIdOf(threadId: string, turnId: string): string | null
  markTurn(threadId: string, clientTurnId: string, turnId: string): void
  queueViewOf(threadId: string, snapshot: import('@poietica/runtime-protocol').QueueSnapshot): QueueView
  settleQueued(threadId: string, clientTurnId: string, outcome: import('@poietica/runtime-protocol').QueueOutcome): void
  settleUnstarted(threadId: string, error: { code: string; message: string }): void
}

export interface EventRouterDeps {
  readonly repo: RouterRepositoryPort
  readonly hub: TimelineService
  readonly journal: RouterJournalPort
  readonly submissions: RouterSubmissionsPort
  readonly clock: import('@poietica/foundation').Clock
  readonly threads: RouterThreadsPort
  readonly emitThreadUpdated: (thread: Thread) => void
  readonly emitTurnState: (state: import('@poietica/product-model').TurnState) => void
  readonly emitTurnDropped: (p: { threadId: string; clientTurnId: string | null; text: string }) => void
  readonly emitQueue: (p: { threadId: string; queue: QueueView }) => void
  readonly emitControls: (p: { threadId: string; controls: Controls }) => void
  readonly emitContextUsage: (p: { threadId: string; usage: ContextUsage | null }) => void
  readonly emitInteractionRequested: (p: { threadId: string; interaction: Interaction }) => void
  readonly emitInteractionResolved: (p: { threadId: string; interactionId: string }) => void
  readonly emitTurnSettled: (p: {
    threadId: string
    outcome: 'completed' | 'cancelled' | 'failed'
    error: { code: string; message: string } | null
  }) => void
  readonly emitUsageSampled: (p: { threadId: string; sample: UsageSample; at: number }) => void
  readonly emitCommandOutput: (p: { threadId: string; text: string; tone: CommandOutputTone }) => void
  readonly emitCommandsChanged: (p: { threadId: string }) => void
  readonly emitFileChanged: (p: { threadId: string } & FileChange) => void
  /** 每个模型步骤结束：Core 在该步骤之后打增量检查点（§14.2）。 */
  readonly onStepCompleted?: (p: { threadId: string; stepId: string }) => void
  readonly emitSideTopic: (p: { threadId: string; topic: import('@poietica/runtime-protocol').SideTopic }) => void
  readonly emitSideDelta: (p: SideDelta) => void
  readonly emitSideNotice: (p: { threadId: string; message: string }) => void
}

export interface EventRouter {
  onEvent(threadId: string, event: EngineSessionEvent): void
  forget(threadId: string): void
  has(threadId: string): boolean
  requestCancel(threadId: string): void
}

export type CreateEventRouter = (deps: EventRouterDeps) => EventRouter

export const EventRouterFactoryToken = defineServiceToken<CreateEventRouter>('timeline', 'EventRouterFactory')

/** 时间线通知用的别名，避免实现层再引一次。 */
export type { TimelineEventsNotice }
