import type { AgentEvent, TranscriptPage } from '@poietica/agent-model'
import { defineServiceToken } from '@poietica/foundation'
import {
  type QueueView,
  type SubmissionAttachment,
  type SubmissionOrigin,
  type SubmissionView,
  submissionErrorText,
} from '@poietica/product-model'
import type { EngineSession, QueueOutcome, QueueSnapshot } from '@poietica/runtime-protocol'
import type { CollectedContext } from './turn-context'

export interface SubmissionWorkspacesPort {
  requireUsable(id: string): { readonly path: string }
  get(id: string): { readonly path: string } | null
}

export interface ResolvedAttachment {
  readonly kind: 'image' | 'file'
  readonly path: string
  readonly mime: string
  readonly name: string
}

export interface SubmissionAttachmentsPort {
  describe(ids: readonly string[]): readonly SubmissionAttachment[]
  retain(ids: readonly string[], ownerKey: string): void
  resolve(ids: readonly string[]): readonly ResolvedAttachment[]
}

export interface SubmissionCheckpointsPort {
  create(input: { workspaceRoot: string; threadId: string; label: string }): Promise<{ readonly id: string }>
}

export interface SubmissionJournalPort {
  append(threadId: string, agentId: string, events: readonly AgentEvent[]): number
}

/** §14.4：工作区同一时刻只允许一个写租约；实现由 workspaces 提供。 */
export interface SubmissionWriteLeasePort {
  acquire(input: {
    workspaceId: string
    threadId: string
    runId?: string
    ttlMs?: number
  }):
    | { readonly granted: true; readonly lease: { readonly id: string } }
    | { readonly granted: false; readonly holder: { readonly threadId: string } }
  release(leaseId: string): void
}

export interface SubmissionServicePorts {
  readonly workspaces: SubmissionWorkspacesPort
  readonly attachments: SubmissionAttachmentsPort
  readonly checkpoints?: SubmissionCheckpointsPort
  readonly journal?: SubmissionJournalPort
  readonly writeLease?: SubmissionWriteLeasePort
  readonly requireThread: (threadId: string) => {
    readonly id: string
    readonly workspaceId: string
  }
  readonly autoTitle: (threadId: string, text: string) => void
  readonly markActivity: (threadId: string) => void
  readonly emitChanged: (submission: SubmissionView) => void
  readonly emitRemoved: (p: { threadId: string; clientTurnId: string }) => void
  readonly emitFailed: (p: {
    threadId: string
    clientTurnId: string
    deliverAs: 'turn' | 'steer' | 'followUp'
    error: { code: string; message: string }
  }) => void
  readonly acquireSession: (threadId: string) => Promise<EngineSession>
  readonly emitUserMessage: (p: { threadId: string; at: number }) => void
  readonly collectContext?: (threadId: string) => CollectedContext
}

export interface SubmissionService {
  configure(ports: SubmissionServicePorts): void
  submit(input: {
    threadId: string
    clientTurnId: string
    text: string
    attachmentIds: readonly string[]
    skills: readonly string[]
    deliverAs: 'turn' | 'steer' | 'followUp'
    /** 缺省按人发的算；定时任务替人投的那段话传 'automation'。 */
    origin?: SubmissionOrigin | undefined
  }): SubmissionView
  retry(clientTurnId: string): SubmissionView
  discard(clientTurnId: string): { threadId: string; clientTurnId: string }
  settleQueued(threadId: string, clientTurnId: string, outcome: QueueOutcome): void
  viewOfThread(threadId: string, stamped: ReadonlySet<string>): SubmissionView[]
  stampPage(threadId: string, page: TranscriptPage): TranscriptPage
  queueViewOf(threadId: string, snapshot: QueueSnapshot): QueueView
  clientTurnIdOf(threadId: string, turnId: string): string | null
  claimPendingTurn(threadId: string): string | null
  markTurn(threadId: string, clientTurnId: string, turnId: string): void
  settleUnstarted(threadId: string, error: { code: string; message: string }): void
  /** 这一轮的写租约结束（轮次收口 / 线程删除 / 提交失败）。没有租约时是空操作。 */
  releaseWriteLease(threadId: string): void
  cancelUnhanded(threadId: string): void
  recoverOnStart(): void
  forget(threadId: string): void
  has(threadId: string): boolean
}

export const SubmissionServiceToken = defineServiceToken<SubmissionService>('runs', 'SubmissionService')

/** 已发布契约里的码；文案由 product-model 的 submissionErrorText 解出（码不是给人看的话）。 */
export const SubmissionErrorCode = {
  threadNotFound: 'conversation.thread_not_found',
  threadBusy: 'conversation.thread_busy',
  submitDropped: 'conversation.submit_dropped',
  submitCancelled: 'conversation.submit_cancelled',
  coreRestarted: 'conversation.core_restarted',
} as const

/** 一个提交结局：码是契约，文案是给人看的那句话。 */
export function submissionFailure(code: string): { code: string; message: string } {
  return { code, message: submissionErrorText(code) }
}
