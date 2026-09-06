import type { ThreadHistory } from '../agent/thread'
import type { TranscriptPage } from '../agent/transcript'
export interface TranscriptSink {
  readonly opening: (threadId: string) => void
  readonly history: (threadId: string, history: ThreadHistory) => void
  readonly failed: (threadId: string, cause: unknown) => void
  readonly route: (sessionId: string, threadId: string, baseline: TranscriptPage) => void
  readonly ownerOf: (sessionId: string) => string | undefined
  readonly forget: (threadId: string) => void
}
