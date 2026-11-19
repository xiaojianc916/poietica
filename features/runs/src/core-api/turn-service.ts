import type { AgentEvent } from '@poietica/agent-model'
import { defineServiceToken } from '@poietica/foundation'
import type {
  ControlsSnapshot,
  QueueView,
  SubmissionOrigin,
  SubmissionView,
  Thread,
  TurnState,
} from '@poietica/product-model'
import type {
  Controls,
  EngineSession,
  Interaction,
  InteractionAnswer,
  ModelRef,
  Posture,
  QueueSnapshot,
  RuntimeServices,
  SideTopic,
  SlashCommand,
} from '@poietica/runtime-protocol'
import type { SessionPool } from './session-pool'
import type { SubmissionService } from './submission-service'

export interface TurnThreadRow {
  readonly workspaceId: string
  readonly sessionFile: string | null
  readonly initialModel: ModelRef | null
  readonly initialThinking: string | null
  readonly posture: Posture
}

export interface TurnThreadsPort {
  requireRow(threadId: string): TurnThreadRow
  threadOf(row: TurnThreadRow): Thread
  setPosture(threadId: string, posture: Posture): void
}

export interface TurnJournalPort {
  latestSeq(threadId: string, agentId: string): number
  read(threadId: string, agentId: string, afterSeq: number, limit?: number): readonly AgentEvent[]
  appendAndStamp(threadId: string, agentId: string, events: readonly AgentEvent[]): readonly AgentEvent[]
}

export interface TurnWorkspacesPort {
  requireUsable(id: string): { readonly path: string }
}

export interface TurnRuntimePort {
  readonly commandCatalog: RuntimeServices['sessions']['commandCatalog']
  readonly draftControls: RuntimeServices['sessions']['draftControls']
  readonly models: RuntimeServices['models']
  readonly sessionFiles: RuntimeServices['sessions']['sessionFiles']
}

export interface TurnServicePorts {
  readonly runtime: TurnRuntimePort
  readonly journal: TurnJournalPort
  readonly repo: { controlsSnapshot(threadId: string): ControlsSnapshot | null }
  readonly pool: SessionPool
  readonly router: { requestCancel(threadId: string): void }
  readonly submissions: SubmissionService
  readonly workspaces: TurnWorkspacesPort
  readonly threads: TurnThreadsPort
  readonly emitThreadUpdated: (thread: Thread) => void
  readonly emitUserMessage: (p: { threadId: string; at: number }) => void
}

export interface TurnService {
  configure(ports: TurnServicePorts): void
  peek(threadId: string): EngineSession | undefined
  open(threadId: string): Promise<void>
  close(threadId: string): Promise<void>
  invalidateSessions(): Promise<void>
  submit(input: {
    threadId: string
    clientTurnId: string
    text: string
    attachmentIds: readonly string[]
    skills: readonly string[]
    deliverAs: 'turn' | 'steer' | 'followUp'
    origin?: SubmissionOrigin | undefined
  }): Promise<{ submission: SubmissionView }>
  cancel(threadId: string): Promise<void>
  submissionsOf(threadId: string, stamped: ReadonlySet<string>): SubmissionView[]
  page(
    threadId: string,
    agentId: string,
    beforeTurnId: string | null,
    throughTurnId?: string | null,
  ): Promise<import('@poietica/agent-model').TranscriptPage>
  queue(threadId: string): Promise<QueueView>
  withdraw(threadId: string, itemId: string): Promise<QueueView>
  move(threadId: string, itemId: string, deliverAs: 'steer' | 'followUp'): Promise<QueueView>
  cancelSubagent(threadId: string, agentId: string): Promise<boolean>
  steerSubagent(threadId: string, agentId: string, text: string): Promise<void>
  cancelBackgroundTask(threadId: string, taskId: string): Promise<boolean>
  setQueueModes(threadId: string, modes: Partial<QueueSnapshot['modes']>): Promise<QueueView>
  controls(threadId: string): Promise<Controls>
  draftControls(init: {
    model: ModelRef | null
    thinking: string | null
    posture: Posture | null
    hidden?: readonly string[] | undefined
  }): Promise<Controls>
  setDraftDefault(input: {
    model: ModelRef | null
    thinking?: string | null
    hidden?: readonly string[]
  }): Promise<void>
  setModel(threadId: string, model: ModelRef): Promise<Controls>
  setThinking(threadId: string, level: string): Promise<Controls>
  setPostureAction(threadId: string, posture: Posture): Promise<Controls>
  setPlanMode(threadId: string, enabled: boolean): Promise<Controls>
  setGoal(threadId: string, goal: string | null): Promise<Controls>
  pauseGoal(threadId: string): Promise<Controls>
  resumeGoal(threadId: string): Promise<Controls>
  commands(threadId: string): Promise<readonly SlashCommand[]>
  commandCatalog(workspaceId: string | undefined): Promise<readonly SlashCommand[]>
  runCommand(threadId: string, text: string): Promise<void>
  askSide(threadId: string, question: string, topicId: string | null): Promise<SideTopic>
  cancelSide(threadId: string, topicId: string | null): boolean
  sideTopics(threadId: string): Promise<readonly SideTopic[]>
  interactions(threadId: string): readonly Interaction[]
  respond(threadId: string, interactionId: string, answer: InteractionAnswer): Promise<void>
  stateOf(threadId: string): TurnState['state']
}

export const TurnServiceToken = defineServiceToken<TurnService>('runs', 'TurnService')

export const TurnErrorCode = {
  interactionNotFound: 'conversation.interaction_not_found',
} as const
