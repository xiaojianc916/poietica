import type { ThreadHistory } from '../agent'
export interface TranscriptSink {
  readonly opening: (threadId: string) => void
  readonly history: (threadId: string, history: ThreadHistory) => void
  readonly failed: (threadId: string, cause: unknown) => void
  readonly route: (sessionId: string, threadId: string) => void
  readonly ownerOf: (sessionId: string) => string | undefined
  readonly forget: (threadId: string) => void
}
