import { SessionControlsContext, TranscriptsContext } from '@poietica/assistant'
import type { ConversationRuntime } from '@poietica/conversation'
import type { ReactNode } from 'react'
import { ThreadsContext } from './threads-context'

export function ThreadsProvider({
  conversation,
  children,
}: {
  readonly conversation: ConversationRuntime
  readonly children: ReactNode
}) {
  return (
    <TranscriptsContext value={conversation.transcripts}>
      <SessionControlsContext value={conversation.controls}>
        <ThreadsContext value={conversation.threads}>{children}</ThreadsContext>
      </SessionControlsContext>
    </TranscriptsContext>
  )
}
