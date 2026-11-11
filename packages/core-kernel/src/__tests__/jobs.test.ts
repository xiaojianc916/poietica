import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { fakeClock } from '@poietica/test-kit'
import { createIdempotency } from '../idempotency'
import { createKernelJobs } from '../jobs'

describe('kernel jobs', () => {
  test('到期认领、完成、失败退避、租约收回', () => {
    const clock = fakeClock(1_000)
    const db = openDatabase(':memory:')
    const jobs = createKernelJobs(db, { clock })

    const id = jobs.enqueue({ kind: 'index', payload: { path: 'a' } })
    expect(jobs.count()).toBe(1)
    const first = jobs.claim(1, 5_000)
    expect(first).toMatchObject([{ id, kind: 'index', payload: { path: 'a' } }])
    expect(jobs.claim(1, 5_000)).toHaveLength(0)

    clock.advance(6_000)
    expect(jobs.claim(1, 5_000)).toHaveLength(1)

    jobs.fail(id, 'boom', 10_000)
    expect(jobs.claim(1)).toHaveLength(0)
    clock.advance(10_000)
    expect(jobs.claim(1)?.[0]?.attempts).toBe(3)
    jobs.complete(id)
    expect(jobs.count()).toBe(0)
    db.close()
  })
})

describe('kernel idempotency', () => {
  test('同键只记一次，过期后可重记', () => {
    const clock = fakeClock(1_000)
    const db = openDatabase(':memory:')
    const idem = createIdempotency(db, { clock })

    expect(idem.remember('github', 'pr-1', { number: 1 }, 5_000)).toBe(true)
    expect(idem.remember('github', 'pr-1', { number: 2 }, 5_000)).toBe(false)
    expect(idem.get('github', 'pr-1')).toEqual({ number: 1 })

    clock.advance(6_000)
    expect(idem.get('github', 'pr-1')).toBeNull()
    expect(idem.remember('github', 'pr-1', { number: 2 }, 5_000)).toBe(true)
    expect(idem.get('github', 'pr-1')).toEqual({ number: 2 })
    db.close()
  })
})
