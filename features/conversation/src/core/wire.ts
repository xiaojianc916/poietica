import type { NotificationParams, ResultOf } from '@poietica/contract-kit'
import type { TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import type { conversationContract } from '../contract'
import type { TimelineOpsNotice, TimelineResetNotice } from './timeline-hub'

/*
 * 线上形状与内存形状之间唯一的转换点。
 *
 * @poietica/transcript 的实体字段是 readonly（它是三个进程共用的一份不可变模型），而契约的 zod
 * 输出是可变的 JSON 形状。两者说的是同一样东西：RPC 上跑的就是 JSON，字段一个不改（05 页 §12.1
 * “迁移时不改动任何字段”；契约形状以 05 页 §11 为准）。这里只做一次编译期收窄，运行时零成本；
 * subscribe 的严格模式会在收端用 zod 重新解析，形状不对会立刻报出来。
 */
type OpsParams = NotificationParams<typeof conversationContract, 'timeline.ops'>
type ResetParams = NotificationParams<typeof conversationContract, 'timeline.reset'>
type PageResult = ResultOf<typeof conversationContract, 'timeline.page'>
type CatchUpResult = ResultOf<typeof conversationContract, 'timeline.catchUp'>
type SnapshotResult = ResultOf<typeof conversationContract, 'timeline.subscribe'>

export function wireOpsNotice(p: TimelineOpsNotice): OpsParams {
  return p as unknown as OpsParams
}

export function wireResetNotice(p: TimelineResetNotice): ResetParams {
  return p as unknown as ResetParams
}

export function wirePage(page: TranscriptPage): PageResult {
  return page as unknown as PageResult
}

export function wireSnapshot(
  page: TranscriptPage,
  epoch: number,
  seq: number,
  submissions: readonly import('../contract').SubmissionView[],
): SnapshotResult {
  return { page: page as unknown as SnapshotResult['page'], epoch, seq, submissions: [...submissions] }
}

export function wireCatchUp(r: {
  batches: { seq: number; ops: readonly TranscriptOperation[] }[]
  latestSeq: number
  complete: boolean
}): CatchUpResult {
  return r as unknown as CatchUpResult
}
