import { defineServiceToken } from '@poietica/foundation'
import type { Thread, TurnState } from '@poietica/product-model'
import { attachmentOwnerKeyOf } from '@poietica/product-model'
import type { EngineSession, ModelRef, OpenSessionSpec, Posture, RuntimeServices } from '@poietica/runtime-protocol'
import type { ThreadRow } from './types'

/** 线程服务只需要这几格运行时能力；不是完整引擎。 */
export interface ThreadsRuntimePort {
  readonly sessionFiles: RuntimeServices['sessions']['sessionFiles']
}

export interface ThreadsWorkspacesPort {
  requireUsable(id: string): { readonly path: string }
}

export interface ThreadsAttachmentsPort {
  copyOwner(from: string, to: string): void
  releaseOwner(ownerKey: string): void
}

export interface ThreadsTimelinePort {
  resetAdvanced(threadId: string): void
  dropHistory(threadId: string): void
  disposeThread(threadId: string): void
}

/** 由 conversation 组合根晚绑定的端口：会话池、工作区、附件、时间线与事件出口。 */
export interface ThreadServicePorts {
  readonly runtime: ThreadsRuntimePort
  readonly workspaces: ThreadsWorkspacesPort
  readonly attachments: ThreadsAttachmentsPort
  readonly hub: ThreadsTimelinePort
  readonly sessionState: (threadId: string) => TurnState['state']
  readonly peekSession: (threadId: string) => EngineSession | undefined
  readonly isOpening: (threadId: string) => boolean
  readonly releaseSession: (threadId: string) => Promise<void>
  readonly emitThreadUpdated: (thread: Thread) => void
  readonly emitThreadRemoved: (threadId: string) => void
  readonly onThreadRemoved: (threadId: string) => void
  /** 删行事务内写持久副作用（outbox）；没有组合根时可为空。 */
  readonly onThreadDeleted?: (threadId: string) => void
}

export interface ThreadsService {
  configure(ports: ThreadServicePorts): void
  row(id: string): ThreadRow | null
  requireRow(id: string): ThreadRow
  threadOf(row: ThreadRow): Thread
  pendingInteractionOf(threadId: string): Thread['pendingInteraction']
  stateOf(threadId: string): TurnState['state']
  list(q: { workspaceId?: string | undefined; includeArchived: boolean }): Thread[]
  create(init: {
    workspaceId: string
    posture?: Posture | undefined
    model?: ModelRef | undefined
    thinking?: string | undefined
    title?: string
    origin?: 'user' | 'automation'
  }): ThreadRow
  rename(id: string, title: string): Promise<ThreadRow>
  setPinned(id: string, pinned: boolean): ThreadRow
  setArchived(id: string, archived: boolean): ThreadRow
  setPosture(id: string, posture: Posture): void
  markActivity(threadId: string): void
  autoTitle(threadId: string, text: string): void
  setTitleFromSession(threadId: string, title: string, source: 'auto' | 'user', sessionFile: string): void
  describe(threadId: string): OpenSessionSpec
  onOpened(threadId: string, session: EngineSession): void
  onReleased(threadId: string): void
  delete(threadId: string): Promise<void>
  fork(threadId: string, keepTurns: number | undefined, title?: string): Promise<ThreadRow>
  exportThread(threadId: string, format: 'html' | 'markdown', targetPath: string): Promise<{ path: string }>
  shareThread(threadId: string): Promise<{ url: string; truncated: boolean }>
  removeWorkspaceThreads(workspaceId: string): Promise<void>
  reclaimPending(): Promise<{ reclaimed: number; failed: number }>
  reconcileSessionFiles(): Promise<{ unbound: number }>
}

export const ThreadsServiceToken = defineServiceToken<ThreadsService>('threads', 'ThreadsService')

/** 附件引用的 ownerKey 拼法：'<功能 id>:<实体>:<id>' */
export const ownerKeyOf = attachmentOwnerKeyOf
export const OWNER_KEY = ownerKeyOf

/** 错误码沿用已发布契约，迁移模块不改变 UI 识别的 code。 */
export const ThreadsErrorCode = {
  notFound: 'conversation.thread_not_found',
  busy: 'conversation.thread_busy',
  empty: 'conversation.thread_empty',
} as const
