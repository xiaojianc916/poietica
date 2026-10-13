import type { TranscriptOperation, TranscriptPage as WireTranscriptPage } from '@poietica/transcript'

/*
 * 保留 legacy 的读法（线上快照 + agent 花名册 + 待答表三合一），字段来源换成：快照 = @poietica/transcript 的
 * TranscriptPage；花名册 = engine 的 task.upsert op 折出来的任务表（ui/timeline/delegate-channel.ts 读它）；待答表 = pendingInteractions。
 */
type AgentTranscriptSnapshot = WireTranscriptPage
type AgentDescriptor = { readonly agentId: string; readonly name?: string }

type TranscriptAgentId = string

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
  /* `seq` 是 server 报的当前水位：缺席即水位未知，只能整读重建；相等即无待补的帧，不必再整读。 */
  | {
      readonly kind: 'reset'
      readonly sessionId: string
      readonly agentId: string
      readonly seq: number | undefined
    }
  | { readonly kind: 'resync'; readonly sessionId: string; readonly reason: string }

export interface TranscriptPort {
  readonly subscribeTranscript: (listener: (signal: TranscriptSignal) => void) => () => void
  readonly readTranscript: (sessionId: string, agentId: string, beforeTurn?: string) => Promise<TranscriptPage>
  readonly catchUpTranscript: (sessionId: string, agentId: string, sinceSeq: number) => Promise<TranscriptCatchUp>
}
