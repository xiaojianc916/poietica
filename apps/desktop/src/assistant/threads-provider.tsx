import type { ConversationRuntime } from '@poietica/conversation'
import { SessionControlsContext, TranscriptsContext } from '@poietica/conversation/surface'
import type { ReactNode } from 'react'
import type { ConversationEntry } from './conversation-entry'
import {
  ConversationEntryContext,
  ThreadsContext,
  WorkspaceCollapseContext,
} from './threads-context'
import type { WorkspaceCollapse } from './workspace-collapse'

export function ThreadsProvider({
  conversation,
  entry,
  collapsed,
  children,
}: {
  readonly conversation: ConversationRuntime
  readonly entry: ConversationEntry
  readonly collapsed: WorkspaceCollapse
  readonly children: ReactNode
}) {
  return (
    <TranscriptsContext value={conversation.transcripts}>
      <SessionControlsContext value={conversation.controls}>
        <ThreadsContext value={conversation.threads}>
          <ConversationEntryContext value={entry}>
            <WorkspaceCollapseContext value={collapsed}>{children}</WorkspaceCollapseContext>
          </ConversationEntryContext>
        </ThreadsContext>
      </SessionControlsContext>
    </TranscriptsContext>
  )
}
