import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { fakeClock } from '@poietica/test-kit'
import { createWorkflowService } from '../workflows'

describe('kernel workflows', () => {
  test('幂等启动、推进一步、未完成清单', () => {
    const clock = fakeClock(1_000)
    const db = openDatabase(':memory:')
    const flows = createWorkflowService(db, { clock })

    const first = flows.start({ id: 'w1', kind: 'deliver-pr', step: 'create-worktree', context: { base: 'main' } })
    expect(first).toMatchObject({ id: 'w1', step: 'create-worktree', state: 'running' })

    clock.advance(1_000)
    expect(flows.start({ id: 'w1', kind: 'deliver-pr', step: 'ignored' }).step).toBe('create-worktree')

    const next = flows.advance('w1', { step: 'open-pr', context: { base: 'main', branch: 'x' } })
    expect(next).toMatchObject({ step: 'open-pr', state: 'running', context: { base: 'main', branch: 'x' } })

    expect(flows.unfinished()).toHaveLength(1)
    flows.advance('w1', { step: 'done', state: 'done' })
    expect(flows.unfinished()).toHaveLength(0)
    db.close()
  })
})
