import { describe, expect, it } from 'bun:test'
import type { SubagentItem, TimelineState, ToolCallTimelineItem } from '@poietica/conversation-kit/timeline'
import { agentTypeOf, delegateRowsOf, faceStatusOf, sayAgentType } from '../delegate-rows'
import { selectPresentation } from '../presentation'

/*
 * 派发行的三个读数（照 ZCode 的 Agent 摘要行）：类型名的印法、描述取谁、状态怎么折成表情档。
 * 这里钉住的是「谁在做什么」那一份，行长什么样交给真机（check:ticker 量的是另一条路）。
 */

function delegate(input: Record<string, unknown>, channels: readonly string[]): ToolCallTimelineItem {
  return {
    type: 'tool_call',
    id: 'frame-1',
    turn: 1,
    at: 0,
    toolCallId: 'call-1',
    title: 'task',
    invokedTool: 'task',
    scheme: '',
    kind: 'delegate',
    headline: '',
    subject: '',
    shape: 'flow',
    status: 'in_progress',
    requestContent: [],
    content: [],
    locations: [],
    channels: channels.map((agentId) => ({ agentId, name: agentId })),
    rawInput: input,
    startedAt: 0,
  }
}

function listed(agentId: string, description: string, status: SubagentItem['status']): SubagentItem {
  return { agentId, description, status }
}

describe('派发行的读数', () => {
  it('类型名连字符换空格、词首大写', () => {
    expect(sayAgentType('general-purpose')).toBe('General Purpose')
    expect(sayAgentType('Explore')).toBe('Explore')
  })

  it('批量派发按序号对上各自的 agent，描述取引擎报的那句', () => {
    const item = delegate(
      {
        tasks: [
          { agent: 'general-purpose', task: '查 A\n更多' },
          { agent: 'Explore', description: '仓库扩展体系调研' },
          { agent: 'Explore' },
        ],
      },
      ['Anna', 'Bob', 'Cid'],
    )
    const rows = delegateRowsOf(item, [listed('Anna', '仓库拓扑调研', 'running')])
    expect(rows[0]).toEqual({
      agentId: 'Anna',
      type: 'General Purpose',
      description: '仓库拓扑调研',
      status: 'running',
    })
    // 还没有生命周期帧的那两条退回入参：批次项自己那句话 → 自己那条任务的首行；没有就退回通道号。
    expect(rows[1]).toEqual({ agentId: 'Bob', type: 'Explore', description: '仓库扩展体系调研', status: undefined })
    expect(rows[2]).toEqual({ agentId: 'Cid', type: 'Explore', description: 'Cid', status: undefined })
  })

  it('两处都问不出描述时退回通道号，行里不留空', () => {
    const rows = delegateRowsOf(delegate({}, ['Anna']), [])
    expect(rows[0]?.description).toBe('Anna')
  })

  it('生命周期四档折成表情档：跑着扫视、完成笑、其余丧', () => {
    expect(faceStatusOf('running')).toBe('running')
    expect(faceStatusOf('completed')).toBe('done')
    expect(faceStatusOf('failed')).toBe('failed')
    expect(faceStatusOf('killed')).toBe('failed')
    expect(faceStatusOf('timed_out')).toBe('failed')
    expect(faceStatusOf(undefined)).toBeUndefined()
  })
})
describe('同一个子代理只有一个颜色', () => {
  it('时间线的行、右坞的标签、通道面板的头取到同一个类型名', () => {
    const item = delegate({ tasks: [{ agent: 'scout', task: '查 om2 是什么' }] }, ['Anna'])
    const state = {
      status: 'idle' as const,
      todos: [],
      backgroundTasks: [],
      subagents: [],
      sealed: [],
      active: { turn: 1, items: [item] },
      spans: [],
    }

    // 行里那一行读到的类型名……
    const rowType = delegateRowsOf(item, state.subagents)[0]?.type
    // ……与按 agentId 回查的那一份必须是同一个串；两处都拿它去散列，颜色才不会分家。
    expect(rowType).toBe('Scout')
    expect(agentTypeOf(state as never, 'Anna')).toBe(rowType ?? '')
  })

  it('标题变了颜色不变：类型名不从标题里取', () => {
    const item = delegate({ tasks: [{ agent: 'scout', task: '查 A' }] }, ['Anna'])
    const before = agentTypeOf(
      {
        status: 'idle',
        todos: [],
        backgroundTasks: [],
        subagents: [],
        sealed: [],
        active: { turn: 1, items: [item] },
        spans: [],
      } as never,
      'Anna',
    )
    // 生命周期帧后来报了一句完全不同的描述，类型名不该跟着走。
    const after = agentTypeOf(
      {
        status: 'idle',
        todos: [],
        backgroundTasks: [],
        subagents: [listed('Anna', '换了完全不同的描述', 'completed')],
        sealed: [],
        active: { turn: 1, items: [item] },
        spans: [],
      } as never,
      'Anna',
    )
    expect(after).toBe(before)
  })
})
describe('派发不并组、无通道也同形', () => {
  it('还没报出通道的派发照样是一行「脸 + 类型名 + 那句话」，不再是另一套字形', () => {
    const rows = delegateRowsOf(delegate({ agent: 'scout', description: 'Resuming main shell agent' }, []), [])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('Scout')
    expect(rows[0]?.description).toBe('Resuming main shell agent')
    // 没有地址：这一行不是入口。
    expect(rows[0]?.agentId).toBe('')
  })

  it('派发调用不并进组头：两条相邻的派发各自成一行，没有「调度子代理 N 次」', () => {
    /* 还没收口的一轮：过程不折，两条派发原样摆在屏幕上（折起来的判据另行有测试）。 */
    const state: TimelineState = {
      status: 'running',
      todos: [],
      backgroundTasks: [],
      subagents: [],
      sealed: [],
      active: {
        turn: 1,
        items: [delegate({}, ['Anna']), { ...delegate({}, ['Bob']), id: 'frame-2', toolCallId: 'call-2' }],
      },
      spans: [],
    }

    const feed = selectPresentation(state, new Map())
    const ids: string[] = []
    for (let index = 0; index < feed.count; index += 1) {
      const row = feed.rowAt(index)
      if (row !== undefined) ids.push(row.item.id)
      // 没有组头：组头会印出「调度子代理 2 次」并把这些行藏进第二层折叠。
      expect(feed.groupAt(index)).toBeUndefined()
    }
    expect(ids).toHaveLength(2)
  })
})
