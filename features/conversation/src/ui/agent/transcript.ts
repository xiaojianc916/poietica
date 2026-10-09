import type { TranscriptOperation, TranscriptPage as WireTranscriptPage } from '@poietica/transcript'

/*
 * 迁移说明：legacy 的 TranscriptPage 是「线上快照 + 多 agent 花名册 + 待答表」三合一
 * （@poietica/contract/conversation 的 AgentTranscriptSnapshot）。新架构把这三样分开了：
 *   - 快照 = @poietica/transcript 的 TranscriptPage（三个进程共用的那一份）；
 *   - 花名册 = engine 的 task.upsert op 折出来的任务表（ui/timeline/delegate-channel.ts 读它）；
 *   - 待答表 = @poietica/transcript 的 pendingInteractions（applyOperation 已经算好）。
 * 这里保留 legacy 的读法，字段来源换成上面三处。
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
  /*
   * Reset invalidates a cursor; the read path re-supplies the populated history window.
   *
   * `seq` 是 server 报的当前水位。缺席即水位未知，下游只能整读重建；在场时就能判
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
  readonly readTranscript: (sessionId: string, agentId: string, beforeTurn?: string) => Promise<TranscriptPage>
  readonly catchUpTranscript: (sessionId: string, agentId: string, sinceSeq: number) => Promise<TranscriptCatchUp>
}
