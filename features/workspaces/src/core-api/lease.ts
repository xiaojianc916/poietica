import { defineServiceToken } from '@poietica/foundation'

export interface WriteLease {
  readonly id: string
  readonly workspaceId: string
  readonly threadId: string
  readonly runId?: string
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface WriteLeaseAcquire {
  readonly workspaceId: string
  readonly threadId: string
  readonly runId?: string
  /** 默认 60 秒 */
  readonly ttlMs?: number
}

export type WriteLeaseResult =
  { readonly granted: true; readonly lease: WriteLease } | { readonly granted: false; readonly holder: WriteLease }

export interface WriteLeaseService {
  /** 同一 Thread 重入只续期；别的 Thread 持有时拒绝并交出持有者 */
  acquire(input: WriteLeaseAcquire): WriteLeaseResult
  /** 续租；租约已过期 / 不存在返回 null */
  renew(leaseId: string, ttlMs?: number): WriteLease | null
  release(leaseId: string): void
  current(workspaceId: string): WriteLease | null
}

export const WriteLeaseServiceToken = defineServiceToken<WriteLeaseService>('workspaces', 'WriteLeaseService')
