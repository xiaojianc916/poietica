import type {
  AgentDescriptor,
  AgentTranscriptSnapshot,
  TranscriptOperation,
} from '@poietica/transcript'

export type TranscriptAgentId = string

export interface TranscriptPage extends AgentTranscriptSnapshot {
  readonly agentId: TranscriptAgentId
  readonly agents: readonly AgentDescriptor[]
  readonly pendingInteractions: readonly string[]
  readonly seq: number
}

export interface TranscriptCatchUp {
  readonly agentId: TranscriptAgentId
  readonly batches: readonly {
    readonly seq: number
    readonly ops: readonly TranscriptOperation[]
  }[]
  readonly latestSeq: number
  readonly complete: boolean
}

export type TranscriptSignal =
  | {
      readonly kind: 'ops'
      readonly sessionId: string
      readonly agentId: string
      readonly seq: number
      readonly ops: readonly TranscriptOperation[]
    }
  /*
   * Reset invalidates a cursor; REST supplies the populated history window.
   *
   * `seq` 是 server 报的当前水位。它缺席时只能照旧去 REST 补一页；在场时就能判
   * 「我们手上这一页是不是已经到那儿了」—— 相等即无待补的帧，不必再整读一次。
   */
  | {
      readonly kind: 'reset'
      readonly sessionId: string
      readonly agentId: string
      readonly seq: number | undefined
    }
  | { readonly kind: 'resync'; readonly sessionId: string; readonly reason: string }

export interface TranscriptPort {
  readonly subscribeTranscript: (listener: (signal: TranscriptSignal) => void) => () => void
  readonly readTranscript: (
    sessionId: string,
    agentId: string,
    beforeTurn?: string,
  ) => Promise<TranscriptPage>
  readonly catchUpTranscript: (
    sessionId: string,
    agentId: string,
    sinceSeq: number,
  ) => Promise<TranscriptCatchUp>
}
