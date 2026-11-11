import { describe, expect, test } from 'bun:test'
import { fakeClock } from '@poietica/test-kit'
import { createWriteLeaseService } from '../lease'

describe('写租约', () => {
  test('同一时刻只给一个 Thread；同 Thread 重入只续期', () => {
    const clock = fakeClock(1_000)
    const leases = createWriteLeaseService({ clock, ttlMs: 10_000 })
    const first = leases.acquire({ workspaceId: 'w', threadId: 't1' })
    expect(first.granted).toBe(true)
    if (!first.granted) return

    const same = leases.acquire({ workspaceId: 'w', threadId: 't1' })
    expect(same).toMatchObject({ granted: true, lease: { id: first.lease.id } })

    const denied = leases.acquire({ workspaceId: 'w', threadId: 't2' })
    expect(denied).toMatchObject({ granted: false, holder: { threadId: 't1' } })
  })

  test('租约过期自动释放；续租延长', () => {
    const clock = fakeClock(1_000)
    const leases = createWriteLeaseService({ clock, ttlMs: 5_000 })
    const first = leases.acquire({ workspaceId: 'w', threadId: 't1' })
    if (!first.granted) throw new Error('应当授予')
    clock.advance(4_000)
    expect(leases.renew(first.lease.id, 5_000)?.expiresAt).toBe(10_000)
    clock.advance(6_000)
    expect(leases.current('w')).toBeNull()
    expect(leases.acquire({ workspaceId: 'w', threadId: 't2' }).granted).toBe(true)
  })
})
