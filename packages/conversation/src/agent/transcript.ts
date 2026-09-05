import type {
  AgentDescriptor,
  AgentTranscriptSnapshot,
  TranscriptOperation,
} from '@poietica/transcript'

export type TranscriptAgentId = string
export type TranscriptTurnId = string

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
  /* Full snapshots are TranscriptPage values, never WS signals. */
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
