import type { Clock } from '@poietica/foundation'
import type { WriteLease, WriteLeaseService } from '../core-api'

export interface CreateWriteLeaseServiceOptions {
  readonly clock: Clock
  /** 默认 60 秒；心跳由持有者在到期前续租 */
  readonly ttlMs?: number
}

/**
 * 每个工作区同一时刻只允许一个写租约（§14.4）。进程内实现：Worker 崩溃或 Core
 * 重启后租约自然消失，不需要持久化；过期即视为释放。
 */
export function createWriteLeaseService(o: CreateWriteLeaseServiceOptions): WriteLeaseService {
  const ttl = Math.max(o.ttlMs ?? 60_000, 1_000)
  const leases = new Map<string, WriteLease>()
  let next = 0

  const live = (workspaceId: string): WriteLease | null => {
    const lease = leases.get(workspaceId)
    if (lease === undefined) return null
    if (lease.expiresAt <= o.clock.now()) {
      leases.delete(workspaceId)
      return null
    }
    return lease
  }

  return {
    acquire(input) {
      const now = o.clock.now()
      const current = live(input.workspaceId)
      if (current !== null && current.threadId !== input.threadId) return { granted: false, holder: current }
      const duration = Math.max(input.ttlMs ?? ttl, 1_000)
      const lease: WriteLease = {
        id: current?.id ?? `lease-${++next}`,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        acquiredAt: current?.acquiredAt ?? now,
        expiresAt: now + duration,
      }
      leases.set(input.workspaceId, lease)
      return { granted: true, lease }
    },
    renew(leaseId, ttlMs) {
      const found = [...leases.values()].find((lease) => lease.id === leaseId)
      if (found === undefined || found.expiresAt <= o.clock.now()) return null
      const nextLease: WriteLease = {
        ...found,
        expiresAt: o.clock.now() + Math.max(ttlMs ?? ttl, 1_000),
      }
      leases.set(found.workspaceId, nextLease)
      return nextLease
    },
    release(leaseId) {
      for (const [workspaceId, lease] of leases) {
        if (lease.id === leaseId) leases.delete(workspaceId)
      }
    },
    current(workspaceId) {
      return live(workspaceId)
    },
  }
}
