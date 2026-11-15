import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@poietica/agent-model'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import journal from '@poietica/feature-journal/core'
import { JournalServiceToken } from '@poietica/feature-journal/core-api'
import { createFakeEngine } from '@poietica/runtime-protocol-testkit'
import { fakeClock } from '@poietica/test-kit'
import { auditContract } from '../../contract'
import audit from '../index'

const AT = '2026-11-15T10:00:00.000Z'

function decided(patch: Partial<Extract<AgentEvent, { type: 'policy.decided' }>> = {}): AgentEvent {
  return {
    type: 'policy.decided',
    schema: 1,
    at: AT,
    durability: 'committed',
    toolName: 'bash',
    category: 'exec',
    action: 'ask',
    rule: 'command.unknown',
    reason: '命令不在安全表内',
    preset: 'auto-edit',
    risk: 'high',
    workspaceRoot: 'D:/ws',
    ...patch,
  }
}

/** 事件是 unknown：这里只取它顶层那个字符串字段，缺字段就是 undefined */
function toolNameOf(event: unknown): string | undefined {
  if (event === null || typeof event !== 'object' || !('toolName' in event)) return undefined
  const value = event.toolName
  return typeof value === 'string' ? value : undefined
}

async function harness() {
  const clock = fakeClock()
  const h = await createCoreHarness({ modules: [journal, audit], engine: createFakeEngine({ clock }), clock })
  const write = (threadId: string, events: readonly AgentEvent[]): void => {
    h.kernel.services.get(JournalServiceToken).append(threadId, 'main', events)
  }
  return { h, write, client: h.client(auditContract) }
}

describe('audit.query', () => {
  test('按类别读 Journal 事实，不另存副本', async () => {
    const { h, write, client } = await harness()
    const event = decided()
    write('t1', [event])

    const all = await client.call('audit.query', { threadId: 't1' })
    expect(all.entries).toHaveLength(1)
    expect(all.entries[0]).toMatchObject({ type: 'policy.decided', at: AT, threadId: 't1', event })

    const approvals = await client.call('audit.query', { threadId: 't1', kinds: ['approval'] })
    expect(approvals.entries).toEqual([])

    const exported = await client.call('audit.export', { threadId: 't1' })
    expect(exported.count).toBe(1)
    expect(JSON.parse(exported.json)).toMatchObject({ threadId: 't1', entries: [{ type: 'policy.decided' }] })
    await h.dispose()
  })

  test('不给 threadId 就是跨线程：两条线程的裁决一起回来', async () => {
    const { h, write, client } = await harness()
    write('t1', [decided()])
    write('t2', [decided({ toolName: 'apply_patch', category: 'file.write', risk: 'medium' })])

    const all = await client.call('audit.query', {})
    expect(all.entries).toHaveLength(2)
    expect(new Set(all.entries.map((entry) => entry.threadId))).toEqual(new Set(['t1', 't2']))

    const scoped = await client.call('audit.query', { threadId: 't2' })
    expect(scoped.entries).toHaveLength(1)
    expect(scoped.entries[0]?.threadId).toBe('t2')
    await h.dispose()
  })

  test('按工具筛：只留这一把工具的裁决，别的类别不会被一并带出来', async () => {
    const { h, write, client } = await harness()
    write('t1', [
      decided(),
      decided({ toolName: 'apply_patch', category: 'file.write', risk: 'medium' }),
      {
        type: 'checkpoint.created',
        schema: 1,
        at: AT,
        durability: 'committed',
        checkpointId: 'c1',
        workspaceRoot: 'D:/ws',
        reason: 'turn_start',
      },
    ])

    const bash = await client.call('audit.query', { tool: 'bash' })
    expect(bash.entries.map((entry) => entry.type)).toEqual(['policy.decided'])
    expect(toolNameOf(bash.entries[0]?.event)).toBe('bash')
    await h.dispose()
  })

  test('按风险等级与工作区筛', async () => {
    const { h, write, client } = await harness()
    write('t1', [
      decided(),
      decided({ toolName: 'read', category: 'file.read', risk: 'low' }),
      decided({ toolName: 'write', category: 'file.write', risk: 'medium', workspaceRoot: 'D:/other' }),
    ])

    const high = await client.call('audit.query', { risk: 'high' })
    expect(high.entries).toHaveLength(1)
    expect(toolNameOf(high.entries[0]?.event)).toBe('bash')

    const elsewhere = await client.call('audit.query', { workspaceRoot: 'D:/other' })
    expect(elsewhere.entries).toHaveLength(1)
    expect(toolNameOf(elsewhere.entries[0]?.event)).toBe('write')
    await h.dispose()
  })

  test('风险条件与检查点类别取交集：没有风险字段的类别不会被结果带出来', async () => {
    const { h, write, client } = await harness()
    write('t1', [
      decided(),
      {
        type: 'checkpoint.created',
        schema: 1,
        at: AT,
        durability: 'committed',
        checkpointId: 'c1',
        workspaceRoot: 'D:/ws',
        reason: 'turn_start',
      },
    ])

    const byRisk = await client.call('audit.query', { risk: 'high', kinds: ['policy', 'checkpoint'] })
    expect(byRisk.entries.map((entry) => entry.type)).toEqual(['policy.decided'])

    /* 工作区两类都有：两个都该回来 */
    const byWorkspace = await client.call('audit.query', { workspaceRoot: 'D:/ws', kinds: ['policy', 'checkpoint'] })
    expect(byWorkspace.entries.map((entry) => entry.type).sort()).toEqual(['checkpoint.created', 'policy.decided'])
    await h.dispose()
  })

  test('放行与撤销也算策略事实（§13.5 要留痕的三件事）', async () => {
    const { h, write, client } = await harness()
    write('t1', [
      {
        type: 'policy.granted',
        schema: 1,
        at: AT,
        durability: 'committed',
        toolName: 'bash',
        grantId: 'g1',
        sessionKey: 't1',
        expiresAt: Date.parse(AT),
      },
      {
        type: 'policy.revoked',
        schema: 1,
        at: AT,
        durability: 'committed',
        grantId: 'g1',
        toolName: 'bash',
        sessionKey: 't1',
        removed: true,
      },
    ])

    const policy = await client.call('audit.query', { kinds: ['policy'] })
    expect(policy.entries.map((entry) => entry.type).sort()).toEqual(['policy.granted', 'policy.revoked'])
    await h.dispose()
  })

  test('没有匹配时是空数组，不报错', async () => {
    const { h, client } = await harness()
    expect((await client.call('audit.query', { tool: 'nope' })).entries).toEqual([])
    expect((await client.call('audit.query', { risk: 'none', kinds: ['approval'] })).entries).toEqual([])
    await h.dispose()
  })
})
