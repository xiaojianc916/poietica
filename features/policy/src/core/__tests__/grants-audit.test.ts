import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@poietica/agent-model'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import journal from '@poietica/feature-journal/core'
import { JournalServiceToken } from '@poietica/feature-journal/core-api'
import settings from '@poietica/feature-settings/core'
import { createFakeEngine } from '@poietica/runtime-protocol-testkit'
import { fakeClock } from '@poietica/test-kit'
import { policyContract } from '../../contract'
import policy from '../index'

/*
 * 授权管理页背后的事实链：记录落在 policy_grants、发放与撤销各写一条 Journal 事件、
 * 撤销之后再裁决又回到「要问」。这里走真实内核 + 真实 journal/settings 模块，不钉实现细节。
 */
async function harness() {
  const clock = fakeClock()
  const h = await createCoreHarness({
    modules: [settings, journal, policy],
    engine: createFakeEngine({ clock }),
    clock,
  })
  return { clock, h, client: h.client(policyContract) }
}

function eventsOf(h: Awaited<ReturnType<typeof harness>>['h'], threadId: string): readonly AgentEvent[] {
  return h.kernel.services.get(JournalServiceToken).read(threadId, 'main', 0, 500)
}

describe('policy.grants', () => {
  test('发放放行写一条 policy.granted；列表读得到；撤销写一条 policy.revoked', async () => {
    const { h, client } = await harness()
    const service = h.kernel.services.get((await import('../../core-api')).PolicyServiceToken)
    const grant = service.grant({ sessionKey: 't1', toolName: 'bash' })

    const listed = await client.call('policy.grants.list', {})
    expect(listed.grants).toHaveLength(1)
    expect(listed.grants[0]).toMatchObject({ id: grant.id, sessionKey: 't1', toolName: 'bash' })

    const granted = eventsOf(h, 't1').filter((event) => event.type === 'policy.granted')
    expect(granted).toHaveLength(1)
    expect(granted[0]).toMatchObject({
      type: 'policy.granted',
      durability: 'committed',
      toolName: 'bash',
      grantId: grant.id,
      sessionKey: 't1',
    })

    const revoked = await client.call('policy.grants.revoke', { grantId: grant.id })
    expect(revoked.revoked).toBe(true)
    expect((await client.call('policy.grants.list', {})).grants).toEqual([])

    const revocations = eventsOf(h, 't1').filter((event) => event.type === 'policy.revoked')
    expect(revocations).toHaveLength(1)
    expect(revocations[0]).toMatchObject({ grantId: grant.id, toolName: 'bash', removed: true })
    await h.dispose()
  })

  test('撤销一条早就不在的记录：报 false，事件里写明没删掉任何东西', async () => {
    const { h, client } = await harness()
    const result = await client.call('policy.grants.revoke', { grantId: 'gone' })
    expect(result.revoked).toBe(false)
    const revoked = h.kernel.services.get(JournalServiceToken).query(['policy.revoked'], { limit: 50 })
    expect(revoked).toHaveLength(1)
    expect(revoked[0]?.event).toMatchObject({ grantId: 'gone', removed: false })
    await h.dispose()
  })
})

describe('policy.check', () => {
  test('裁决写进 Journal（带风险等级与工作区），并把命中规则一起交回', async () => {
    const { h, client } = await harness()
    const decision = await client.call('policy.check', {
      sessionKey: 't1',
      preset: 'auto-edit',
      toolName: 'bash',
      context: { workspaceRoot: 'D:/ws', command: 'git status', url: 'https://api.github.com/x' },
    })
    expect(decision).toMatchObject({ action: 'allow', rule: 'command.safe' })

    const decided = eventsOf(h, 't1').filter((event) => event.type === 'policy.decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({
      type: 'policy.decided',
      toolName: 'bash',
      category: 'exec',
      action: 'allow',
      rule: 'command.safe',
      preset: 'auto-edit',
      risk: 'high',
      workspaceRoot: 'D:/ws',
    })
    await h.dispose()
  })

  test('本会话放行之后同一工具直接放行，规则写明是会话放行', async () => {
    const { h, client } = await harness()
    const first = await client.call('policy.check', {
      sessionKey: 't1',
      preset: 'ask',
      toolName: 'bash',
      context: { workspaceRoot: 'D:/ws', command: 'some-unknown-cmd' },
    })
    expect(first.action).toBe('ask')

    const service = h.kernel.services.get((await import('../../core-api')).PolicyServiceToken)
    service.grant({ sessionKey: 't1', toolName: 'bash' })

    const second = await client.call('policy.check', {
      sessionKey: 't1',
      preset: 'ask',
      toolName: 'bash',
      context: { workspaceRoot: 'D:/ws', command: 'some-unknown-cmd' },
    })
    expect(second).toMatchObject({ action: 'allow', rule: 'policy.session_grant' })

    /* 别的会话不受这条记录影响 */
    const other = await client.call('policy.check', {
      sessionKey: 't2',
      preset: 'ask',
      toolName: 'bash',
      context: { workspaceRoot: 'D:/ws', command: 'some-unknown-cmd' },
    })
    expect(other.action).toBe('ask')
    await h.dispose()
  })

  test('网络目标走出口白名单：命中放行、未命中询问，规则与主机都在裁决里', async () => {
    const { h, client } = await harness()
    const allowed = await client.call('policy.check', {
      sessionKey: 't1',
      preset: 'auto-edit',
      toolName: 'fetch',
      context: { workspaceRoot: 'D:/ws', url: 'https://registry.npmjs.org/left-pad' },
    })
    expect(allowed).toMatchObject({ action: 'allow' })
    expect(allowed.network).toMatchObject({ rule: 'network.allowlist', host: 'registry.npmjs.org' })

    const blocked = await client.call('policy.check', {
      sessionKey: 't1',
      preset: 'auto-edit',
      toolName: 'fetch',
      context: { workspaceRoot: 'D:/ws', url: 'https://exfil.example/upload' },
    })
    expect(blocked).toMatchObject({ action: 'ask', rule: 'network.not_allowlisted' })
    expect(blocked.network?.reason).toContain('exfil.example')
    await h.dispose()
  })
})
