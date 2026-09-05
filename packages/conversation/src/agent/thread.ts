import type { AgentHistory, AgentThread } from '@poietica/contract/conversation'
import type { ThreadId } from './address'
import type { SessionConfigControl } from './config'
import type { SessionGoal } from './goal'
import type { TranscriptPage } from './transcript'
import type { SessionUsage } from './usage'

export type ThreadTitleSource = AgentThread['titleSource']
export type ThreadRecord = Readonly<
  Omit<AgentThread, 'threadId' | 'pinned' | 'workspaceRoot' | 'archived'> & {
    threadId: ThreadId
  } & Partial<Pick<AgentThread, 'pinned' | 'workspaceRoot' | 'archived'>>
>
export type ThreadHistory = Readonly<AgentHistory>
export type ThreadHistoryLoss = Extract<AgentHistory, { state: 'unavailable' }>['reason']

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
  readonly rename?: (threadId: ThreadId, title: string) => Promise<void>
  readonly remove?: (threadId: ThreadId) => Promise<void>
  readonly fork?: (threadId: ThreadId, title: string, dropTurns: number) => Promise<ThreadRecord>
  readonly archive?: (threadId: ThreadId, archived: boolean) => Promise<void>
  readonly setPinned?: (threadId: ThreadId, pinned: boolean) => Promise<void>
}
