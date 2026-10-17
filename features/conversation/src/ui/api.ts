import type { ContextUsage, Controls, Interaction, InteractionAnswer, ModelRef, Posture } from '@poietica/engine'
import type { TypedRpcClient } from '@poietica/rpc'
import type { TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import { conversationContract } from '../contract'
import type { QueueView, SubmissionView, Thread, TimelineSnapshot, TurnState } from '../contract/entities'

/** 把方法名收在一处，组件不认字符串。 */
export function createConversationApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof conversationContract> = ctx.rpc(conversationContract)
  return {
    listThreads: async (q: { workspaceId?: string; includeArchived: boolean }): Promise<Thread[]> =>
      (await rpc.call('threads.list', q)).threads,
    getThread: (threadId: string): Promise<Thread> => rpc.call('threads.get', { threadId }),
    /** `posture` / `model` / `thinking` 是入口页那排选择器的**本地草稿**，必须原样透传：少透一格，选的档位就静默丢掉（CV-14）。 */
    createThread: (p: {
      workspaceId: string
      posture?: Posture
      model?: ModelRef
      thinking?: string
    }): Promise<Thread> => rpc.call('threads.create', p),
    openThread: (threadId: string): Promise<Thread> => rpc.call('threads.open', { threadId }),
    closeThread: (threadId: string): Promise<void> => rpc.call('threads.close', { threadId }).then(() => undefined),
    renameThread: (threadId: string, title: string): Promise<Thread> => rpc.call('threads.rename', { threadId, title }),
    setPinned: (threadId: string, pinned: boolean): Promise<Thread> =>
      rpc.call('threads.setPinned', { threadId, pinned }),
    setArchived: (threadId: string, archived: boolean): Promise<Thread> =>
      rpc.call('threads.setArchived', { threadId, archived }),
    deleteThread: (threadId: string): Promise<void> => rpc.call('threads.delete', { threadId }).then(() => undefined),
    forkThread: (p: { threadId: string; keepTurns?: number; title?: string }): Promise<Thread> =>
      rpc.call('threads.fork', p),
    exportThread: (p: {
      threadId: string
      format: 'html' | 'markdown'
      targetPath: string
    }): Promise<{ path: string }> => rpc.call('threads.export', p),

    submit: (p: {
      threadId: string
      clientTurnId: string
      text: string
      attachmentIds: string[]
      skills: string[]
      deliverAs: 'turn' | 'steer' | 'followUp'
    }): Promise<SubmissionView> => rpc.call('turns.submit', p).then((r) => r.submission),
    retrySubmission: (clientTurnId: string): Promise<SubmissionView> =>
      rpc.call('submissions.retry', { clientTurnId }).then((r) => r.submission),
    discardSubmission: (clientTurnId: string): Promise<void> =>
      rpc.call('submissions.discard', { clientTurnId }).then(() => undefined),
    onSubmissionChanged: (l: (p: { threadId: string; submission: SubmissionView }) => void) =>
      rpc.on('submissions.changed', l),
    onSubmissionRemoved: (l: (p: { threadId: string; clientTurnId: string }) => void) =>
      rpc.on('submissions.removed', l),
    cancelTurn: (threadId: string): Promise<void> => rpc.call('turns.cancel', { threadId }).then(() => undefined),

    subscribeTimeline: (threadId: string, agentId: string): Promise<TimelineSnapshot> =>
      rpc.call('timeline.subscribe', { threadId, agentId }),
    timelinePage: (threadId: string, agentId: string, beforeTurnId: string | null): Promise<TranscriptPage> =>
      rpc.call('timeline.page', { threadId, agentId, beforeTurnId }),
    catchUp: (
      threadId: string,
      agentId: string,
      epoch: number,
      sinceSeq: number,
    ): Promise<{ batches: { seq: number; ops: TranscriptOperation[] }[]; latestSeq: number; complete: boolean }> =>
      rpc.call('timeline.catchUp', { threadId, agentId, epoch, sinceSeq }),
    getQueue: (threadId: string): Promise<QueueView> => rpc.call('queue.get', { threadId }),
    withdraw: (threadId: string, itemId: string): Promise<QueueView> =>
      rpc.call('queue.withdraw', { threadId, itemId }),
    move: (threadId: string, itemId: string, deliverAs: 'steer' | 'followUp'): Promise<QueueView> =>
      rpc.call('queue.move', { threadId, itemId, deliverAs }),
    setQueueModes: (
      threadId: string,
      modes: { steer?: QueueView['modes']['steer']; followUp?: QueueView['modes']['followUp'] },
    ): Promise<QueueView> => rpc.call('queue.setModes', { threadId, ...modes }),
    /** 入口那一格（还没有对话）的**草稿**控件表：带上本地草稿、只读、不开会话；改选择本身走入口页自己的 state。 */
    getDraftControls: (draft: {
      model: ModelRef | null
      thinking: string | null
      posture: Posture | null
    }): Promise<Controls> => rpc.call('controls.draft', draft),
    getControls: (threadId: string): Promise<Controls> => rpc.call('controls.get', { threadId }),
    setModel: (threadId: string, model: ModelRef): Promise<Controls> =>
      rpc.call('controls.setModel', { threadId, model }),
    setThinking: (threadId: string, level: string): Promise<Controls> =>
      rpc.call('controls.setThinking', { threadId, level }),
    setPosture: (threadId: string, posture: Posture): Promise<Controls> =>
      rpc.call('controls.setPosture', { threadId, posture }),
    setPlanMode: (threadId: string, enabled: boolean): Promise<Controls> =>
      rpc.call('controls.setPlanMode', { threadId, enabled }),
    setGoal: (threadId: string, goal: string | null): Promise<Controls> =>
      rpc.call('controls.setGoal', { threadId, goal }),
    pauseGoal: (threadId: string): Promise<Controls> => rpc.call('controls.pauseGoal', { threadId }),
    resumeGoal: (threadId: string): Promise<Controls> => rpc.call('controls.resumeGoal', { threadId }),
    respond: (threadId: string, interactionId: string, answer: InteractionAnswer): Promise<void> =>
      rpc.call('interactions.respond', { threadId, interactionId, answer }).then(() => undefined),

    onThreadUpdated: (l: (t: Thread) => void) => rpc.on('threads.updated', l),
    onThreadRemoved: (l: (p: { threadId: string }) => void) => rpc.on('threads.removed', l),
    onTurnState: (l: (s: TurnState) => void) => rpc.on('turns.state', l),
    onTurnDropped: (l: (p: { threadId: string; clientTurnId: string | null; text: string }) => void) =>
      rpc.on('turns.dropped', l),
    onTimelineOps: (
      l: (p: { threadId: string; agentId: string; epoch: number; seq: number; ops: TranscriptOperation[] }) => void,
    ) => rpc.on('timeline.ops', l),
    onTimelineReset: (l: (p: { threadId: string; agentId: string; epoch: number }) => void) =>
      rpc.on('timeline.reset', l),
    onQueueChanged: (l: (p: { threadId: string; queue: QueueView }) => void) => rpc.on('queue.changed', l),
    onControlsChanged: (l: (p: { threadId: string; controls: Controls }) => void) => rpc.on('controls.changed', l),
    /** 上下文用量单独一条通道，别并进 controls.changed（理由见契约里 controls.contextChanged 的头注）。 */
    onContextUsage: (l: (p: { threadId: string; usage: ContextUsage | null }) => void) =>
      rpc.on('controls.contextChanged', l),
    onDraftControlsChanged: (l: () => void) => rpc.on('controls.draftChanged', l),
    onInteractionRequested: (l: (p: { threadId: string; interaction: Interaction }) => void) =>
      rpc.on('interactions.requested', l),
    onInteractionResolved: (l: (p: { threadId: string; interactionId: string }) => void) =>
      rpc.on('interactions.resolved', l),
  }
}

export type ConversationApi = ReturnType<typeof createConversationApi>

/** 契约直接用契约本身，不从 `ctx.contract` 读（那只是把契约挂到功能上下文上的另一种读法）。 */
declare module '@poietica/ui-kernel' {
  interface UiFeatureContext {
    readonly contract?: unknown
  }
}
