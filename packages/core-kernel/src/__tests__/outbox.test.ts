import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '@poietica/storage-sqlite'
import { fakeClock } from '@poietica/test-kit'
import { createOutbox } from '../outbox'

describe('kernel outbox', () => {
  test('幂等入队、到期认领、完成后删除', () => {
    const clock = fakeClock(1_000)
    const db = openDatabase(':memory:')
    const outbox = createOutbox(db, { clock })

    const first = outbox.enqueue({ topic: 'turn', payload: { n: 1 }, idempotencyKey: 'k1' })
    const again = outbox.enqueue({ topic: 'turn', payload: { n: 2 }, idempotencyKey: 'k1' })
    expect(again).toBe(first)
    expect(outbox.pendingCount()).toBe(1)

    const claimed = outbox.claim(10)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.payload).toEqual({ n: 1 })
    expect(outbox.claim(10)).toHaveLength(0)

    outbox.complete(first)
    expect(outbox.pendingCount()).toBe(0)
    db.close()
  })

  test('失败退避，租约超时可收回', () => {
    const clock = fakeClock(1_000)
    const db = openDatabase(':memory:')
    const outbox = createOutbox(db, { clock })
    const id = outbox.enqueue({ topic: 'x', payload: null })

    const first = outbox.claim(1, 5_000)
    expect(first).toHaveLength(1)
    clock.advance(6_000)
    expect(outbox.claim(1, 5_000)).toHaveLength(1)

    outbox.fail(id, 'boom', 10_000)
    expect(outbox.claim(1)).toHaveLength(0)
    clock.advance(10_000)
    expect(outbox.claim(1)?.[0]?.attempts).toBe(3)
    db.close()
  })

  test('只读模式不建表、不写库', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'poietica-outbox-'))
    const file = path.join(dir, 'db.sqlite')
    openDatabase(file).close()
    const clock = fakeClock()
    const db = openDatabase(file, { readonly: true })
    const outbox = createOutbox(db, { clock, readonly: true })
    expect(() => outbox.enqueue({ topic: 'x', payload: null })).toThrow('只读模式')
    db.close()
    await rm(dir, { recursive: true, force: true })
  })
})
