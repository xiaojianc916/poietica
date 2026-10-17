import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation, type TranscriptTurn } from '@poietica/transcript'
import type { OmpMessage } from '../../projector/history'
import { SubagentChannels } from '../subagent-channels'

function harness(messages: readonly OmpMessage[] = []) {
  const emitted: { agentId: string; ops: readonly TranscriptOperation[] }[] = []
  const channels = new SubagentChannels({
    now: () => 1_700_000_000_000,
    emit: (agentId, ops) => emitted.push({ agentId, ops }),
    readMessages: async (agentId: string) => (agentId === 'Anna' ? messages : []),
    warn: () => undefined,
  })
  const feed = (id: string, event: Record<string, unknown>) => channels.event({ id, event })
  const stateOf = (agentId: string) =>
    emitted
      .filter((entry) => entry.agentId === agentId)
      .reduce((state, entry) => applyOps(state, entry.ops), emptyTimeline())
  return { channels, emitted, feed, stateOf }
}

const turnsOf = (items: readonly { readonly kind: string }[]): TranscriptTurn[] =>
  items.filter((item): item is TranscriptTurn => item.kind === 'turn')

describe('SubagentChannels', () => {
  test('一个子代理的一轮：用户句开轮、助手流式、工具、轮终；只发到它自己的通道', () => {
    const { feed, emitted, stateOf } = harness()
    feed('Anna', { type: 'message_start', message: { role: 'user', content: '查一下依赖' } })
    feed('Anna', { type: 'message_start', message: { role: 'assistant' } })
    feed('Anna', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '好的', contentIndex: 0 },
    })
    feed('Anna', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } })
    feed('Anna', { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: { content: [] } })
    feed('Anna', { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
    feed('Anna', { type: 'agent_end' })
    expect(new Set(emitted.map((entry) => entry.agentId))).toEqual(new Set(['Anna']))
    const turns = turnsOf(stateOf('Anna').items)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ turnId: 't1', prompt: '查一下依赖', state: 'completed' })
  })

  test('开着一轮时的用户句是插话（引导），不另开一轮；被停（aborted）的轮收成 cancelled', () => {
    const { feed, stateOf } = harness()
    feed('Bob', { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '开始' }] } })
    feed('Bob', { type: 'message_start', message: { role: 'user', content: '换个思路' } })
    feed('Bob', { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } })
    feed('Bob', { type: 'agent_end' })
    const state = stateOf('Bob')
    const turns = turnsOf(state.items)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.state).toBe('cancelled')
    const frames = turns.flatMap((turn) => turn.steps.flatMap((step) => step.frames))
    expect(frames.some((frame) => frame.kind === 'text' && frame.role === 'user' && frame.text === '换个思路')).toBe(
      true,
    )
  })

  test('认不出的号（main、路径样）整帧丢掉', () => {
    const { feed, emitted } = harness()
    feed('main', { type: 'message_start', message: { role: 'user', content: 'x' } })
    feed('../x', { type: 'message_start', message: { role: 'user', content: 'x' } })
    expect(emitted).toEqual([])
  })

  test('整页：封口的轮来自会话文件；开着的那一轮换成实时版本', async () => {
    const history: OmpMessage[] = [
      { role: 'user', content: '第一件', timestamp: 1 } as unknown as OmpMessage,
      {
        role: 'assistant',
        content: [{ type: 'text', text: '做完了' }],
        stopReason: 'stop',
        timestamp: 2,
      } as unknown as OmpMessage,
    ]
    const { channels, feed } = harness(history)
    feed('Anna', { type: 'message_start', message: { role: 'user', content: '第一件' } })
    feed('Anna', { type: 'agent_end' })
    feed('Anna', { type: 'message_start', message: { role: 'user', content: '第二件' } })
    const page = await channels.page('Anna', null)
    const turns = turnsOf(page.items)
    expect(turns.map((turn) => [turn.turnId, turn.state])).toEqual([
      ['t1', 'completed'],
      ['t2', 'running'],
    ])
    expect(turnsOf((await channels.page('Nobody', null)).items)).toHaveLength(0)
  })
})
