import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { fakeClock } from '@poietica/test-kit'
import { resumeWorkflows } from '../workflow-resume'
import { createWorkflowService } from '../workflows'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return this
  },
}

describe('workflow resume', () => {
  test('只续跑 running；无 handler 或失败保持原状', async () => {
    const clock = fakeClock(1_000)
    const db = openDatabase(':memory:')
    const workflows = createWorkflowService(db, { clock })
    workflows.start({ id: 'a', kind: 'ok', step: 'one' })
    workflows.start({ id: 'b', kind: 'orphan', step: 'one' })
    workflows.start({ id: 'c', kind: 'boom', step: 'one' })
    workflows.start({ id: 'd', kind: 'ok', step: 'one' })
    workflows.advance('d', { step: 'done', state: 'done' })

    const seen: string[] = []
    const resumed = await resumeWorkflows({
      workflows,
      logger,
      handlers: [
        {
          kind: 'ok',
          resume: (record) => {
            seen.push(record.id)
            workflows.advance(record.id, { step: 'done', state: 'done' })
          },
        },
        {
          kind: 'boom',
          resume: () => {
            throw new Error('nope')
          },
        },
      ],
    })
    expect(resumed).toBe(1)
    expect(seen).toEqual(['a'])
    expect(workflows.get('a')?.state).toBe('done')
    expect(workflows.get('b')?.state).toBe('running')
    expect(workflows.get('c')?.state).toBe('running')
    db.close()
  })
})
