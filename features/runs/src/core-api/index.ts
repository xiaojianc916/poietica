import { defineServiceToken } from '@poietica/foundation'
import type { SubmissionAttachment, SubmissionView } from '@poietica/product-model'

/** 提交表：每条提交都有确定结局并存库；表名仍用历史 `conversation_submissions`。 */
export interface SubmissionRow {
  clientTurnId: string
  threadId: string
  text: string
  attachments: readonly SubmissionAttachment[]
  skills: readonly string[]
  requestedAs: 'turn' | 'steer' | 'followUp'
  status: SubmissionView['status']
  turnId: string | null
  error: { code: string; message: string } | null
  rev: number
  createdAt: number
  updatedAt: number
}

export function submissionOf(row: SubmissionRow): SubmissionView {
  return {
    clientTurnId: row.clientTurnId,
    threadId: row.threadId,
    text: row.text,
    attachments: [...row.attachments],
    skills: [...row.skills],
    deliverAs: row.requestedAs,
    status: row.status,
    turnId: row.turnId,
    error: row.error === null ? null : { ...row.error },
    rev: row.rev,
    createdAt: row.createdAt,
  }
}

export interface SubmissionsRepository {
  insert(row: SubmissionRow): void
  get(clientTurnId: string): SubmissionRow | null
  listByThread(threadId: string): SubmissionRow[]
  mapByTurnId(threadId: string): ReadonlyMap<string, string>
  findByTurnId(threadId: string, turnId: string): SubmissionRow | null
  update(clientTurnId: string, patch: Partial<Pick<SubmissionRow, 'status' | 'turnId' | 'error'>>): SubmissionRow | null
  delete(clientTurnId: string): void
  failUndelivered(error: { code: string; message: string }): SubmissionRow[]
  deleteStaleTerminal(cutoff: number): void
}

export const SubmissionsRepositoryToken = defineServiceToken<SubmissionsRepository>('runs', 'SubmissionsRepository')

export * from './session-pool'

export * from './turn-context'
