import { describe, expect, test } from 'bun:test'
import { openDatabase, runMigrations } from '@poietica/storage-sqlite'
import { fakeClock } from '@poietica/test-kit'
import { createPolicyGrantsRepository } from '../grants'
import { migrations } from '../migrations'

function make() {
  const db = openDatabase(':memory:')
  runMigrations(db, [{ moduleId: 'policy', migrations }])
  const clock = fakeClock()
  return { db, clock, repo: createPolicyGrantsRepository(db.forModule('policy')) }
}

describe('policy_grants', () => {
  test('本会话放行落库；过期后 isGranted 为 false；撤销生效', () => {
    const { db, clock, repo } = make()
    const grant = repo.grant({ sessionKey: 't1', toolName: 'bash', now: clock.now(), ttlMs: 1000 })
    expect(grant).toMatchObject({ sessionKey: 't1', toolName: 'bash' })
    expect(repo.isGranted('t1', 'bash', clock.now())).toBe(true)
    expect(repo.isGranted('t1', 'read', clock.now())).toBe(false)
    expect(repo.list(clock.now())).toHaveLength(1)

    clock.advance(1001)
    expect(repo.isGranted('t1', 'bash', clock.now())).toBe(false)
    expect(repo.list(clock.now())).toEqual([])

    const next = repo.grant({ sessionKey: 't1', toolName: 'bash', now: clock.now(), ttlMs: 1000 })
    expect(repo.revoke(next.id)).toBe(true)
    expect(repo.isGranted('t1', 'bash', clock.now())).toBe(false)
    db.close()
  })

  test('同一会话同一工具重复放行只保留一行', () => {
    const { db, clock, repo } = make()
    repo.grant({ sessionKey: 't1', toolName: 'bash', now: clock.now(), ttlMs: 1000 })
    clock.advance(100)
    repo.grant({ sessionKey: 't1', toolName: 'bash', now: clock.now(), ttlMs: 5000 })
    const grants = repo.list(clock.now())
    expect(grants).toHaveLength(1)
    expect(grants[0]?.expiresAt).toBe(clock.now() + 5000)
    db.close()
  })
})
