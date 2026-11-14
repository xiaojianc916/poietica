import type { TranscriptPage } from '@poietica/conversation-kit/model'
export interface TranscriptSink {
  readonly opening: (threadId: string) => void
  readonly failed: (threadId: string, cause: unknown) => void
  readonly route: (sessionId: string, threadId: string, baseline: TranscriptPage) => void
  readonly forget: (threadId: string) => void
}
