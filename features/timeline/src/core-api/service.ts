import type { AgentEvent } from '@poietica/agent-model'
import { type Disposable, defineServiceToken } from '@poietica/foundation'

export interface TimelineEventsNotice {
  readonly threadId: string
  readonly agentId: string
  readonly epoch: number
  readonly seq: number
  readonly events: readonly AgentEvent[]
}

export interface TimelineResetNotice {
  readonly threadId: string
  readonly agentId: string
  readonly epoch: number
}

export interface TimelineSink {
  events(p: TimelineEventsNotice): void
  reset(p: TimelineResetNotice): void
}

export interface TimelineCatchUp {
  readonly batches: { seq: number; events: readonly AgentEvent[] }[]
  readonly latestSeq: number
  readonly complete: boolean
}

/** 进程内时间线通道：每 (threadId, agentId) 一条，epoch 跨进程不重复。 */
export interface TimelineService extends Disposable {
  configure(sink: TimelineSink): void
  has(threadId: string, agentId: string): boolean
  push(threadId: string, agentId: string, events: readonly AgentEvent[]): void
  reset(threadId: string, agentId: string): void
  position(threadId: string, agentId: string): { epoch: number; seq: number }
  catchUp(threadId: string, agentId: string, epoch: number, sinceSeq: number): TimelineCatchUp
  resetAdvanced(threadId: string): void
  dropHistory(threadId: string): void
  disposeThread(threadId: string): void
}

export const TimelineServiceToken = defineServiceToken<TimelineService>('timeline', 'TimelineService')
