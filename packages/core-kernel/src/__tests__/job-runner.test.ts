import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { fakeClock } from '@poietica/test-kit'
import { createJobRunner } from '../job-runner'
import { createKernelJobs } from '../jobs'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return this
  },
}

describe('job runner', () => {
  test('按 kind 执行；失败退避；未知 kind 保留', async () => {
    const clock = fakeClock(1_000)
    const db = openDatabase(':memory:')
    const jobs = createKernelJobs(db, { clock })
    const seen: unknown[] = []
    jobs.enqueue({ kind: 'ok', payload: { n: 1 } })
    jobs.enqueue({
      kind: 'boom',
      payload: null,
    })
    jobs.enqueue({ kind: 'missing', payload: null })
    const runner = createJobRunner({
      jobs,
      clock,
      logger,
      retryDelayMs: 7_000,
      handlers: [
        { kind: 'ok', handle: (payload) => void seen.push(payload) },
        {
          kind: 'boom',
          handle: () => {
            throw new Error('nope')
          },
        },
      ],
    })
    expect(await runner.tick()).toBe(3)
    expect(seen).toEqual([{ n: 1 }])
    expect(jobs.count()).toBe(2)

    clock.advance(6_999)
    expect(await runner.tick()).toBe(0)
    clock.advance(1)
    expect(await runner.tick()).toBe(2)
    db.close()
  })
})
