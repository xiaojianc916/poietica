import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@poietica/agent-model'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import journal from '@poietica/feature-journal/core'
import { JournalServiceToken } from '@poietica/feature-journal/core-api'
import { createFakeEngine } from '@poietica/runtime-protocol-testkit'
import { fakeClock } from '@poietica/test-kit'
import { auditContract } from '../../contract'
import audit from '../index'

describe('audit.query', () => {
  test('按类别读 Journal 事实，不另存副本', async () => {
    const clock = fakeClock()
    const h = await createCoreHarness({
      modules: [journal, audit],
      engine: createFakeEngine({ clock }),
      clock,
    })
    const event: AgentEvent = {
      type: 'policy.decided',
      schema: 1,
      at: new Date(clock.now()).toISOString(),
      durability: 'committed',
      toolName: 'bash',
      category: 'exec',
      action: 'ask',
      rule: 'command.unknown',
      reason: '命令不在安全表内',
      preset: 'auto-edit',
    }
    h.kernel.services.get(JournalServiceToken).append('t1', 'main', [event])

    const client = h.client(auditContract)
    const all = await client.call('audit.query', { threadId: 't1' })
    expect(all.entries).toHaveLength(1)
    expect(all.entries[0]).toMatchObject({ type: 'policy.decided', at: event.at, event })

    const approvals = await client.call('audit.query', { threadId: 't1', kinds: ['approval'] })
    expect(approvals.entries).toEqual([])
    const exported = await client.call('audit.export', { threadId: 't1' })
    expect(exported.count).toBe(1)
    expect(JSON.parse(exported.json)).toMatchObject({
      threadId: 't1',
      entries: [{ type: 'policy.decided' }],
    })
    await h.dispose()
  })
})
