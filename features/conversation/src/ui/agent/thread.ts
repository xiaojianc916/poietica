import type { ThreadId } from './address'
import type { SessionConfigControl } from './config'
import type { AgentHistory, AgentThread } from './dto'
import type { SessionGoal } from './goal'
import type { TranscriptPage } from './transcript'
import type { SessionUsage } from './usage'

export type ThreadRecord = Readonly<
  Omit<AgentThread, 'threadId' | 'pinned' | 'workspaceRoot' | 'archived'> & {
    threadId: ThreadId
  } & Partial<Pick<AgentThread, 'pinned' | 'workspaceRoot' | 'archived'>>
>
export type ThreadHistory = Readonly<AgentHistory>

export interface TurnMark {
  readonly turnId: string
  readonly admissionId: string
  readonly prompt: string
  readonly reply: string | null
}
export interface ThreadSnapshot {
  readonly thread: ThreadRecord
  readonly usage?: SessionUsage
}
/** 分享把对话上传到第三方，返回那一次的链接。truncated 表示上传的是被截短的一份。 */
export interface SharedThread {
  readonly url: string
  readonly truncated: boolean
}
export interface OpenedThread {
  readonly thread: ThreadRecord
  readonly selectors: readonly SessionConfigControl[]
  readonly goal: SessionGoal | null
  readonly history: ThreadHistory
  readonly transcript: TranscriptPage
}

export interface ThreadPort {
  readonly list: () => Promise<readonly ThreadRecord[]>
  readonly read: (threadId: ThreadId) => Promise<ThreadSnapshot>
  readonly create: (threadId: ThreadId, workspaceRoot?: string | null) => Promise<OpenedThread>
  /** Restores the stored identity; failure must not create a replacement session. */
  readonly open: (threadId: ThreadId) => Promise<OpenedThread>
  readonly export?: (threadId: ThreadId) => Promise<boolean>
  /** Uploads to a third party; must reject instead of resolving with a link that was never created. */
  readonly share?: (threadId: ThreadId) => Promise<SharedThread>
  readonly rename?: (threadId: ThreadId, title: string) => Promise<void>
  readonly remove?: (threadId: ThreadId) => Promise<void>
  /** undoCount counts protocol user anchors, not runs or rendered messages. */
  readonly fork?: (threadId: ThreadId, title: string, undoCount: number) => Promise<ThreadRecord>
  readonly archive?: (threadId: ThreadId, archived: boolean) => Promise<void>
  readonly setPinned?: (threadId: ThreadId, pinned: boolean) => Promise<void>
}
