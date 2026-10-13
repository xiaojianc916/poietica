import { describe, expect, it } from 'bun:test'
import type { ToolCallStatus, ToolKind } from '../../../agent/tool-call'
import { selectPresentation } from '../../../timeline/presentation'
import type { TimelineItem, TimelineState, ToolCallTimelineItem } from '../../../timeline/timeline-contract'

/* 对话内组件（审查 R-18）不并进过程组，落定后也不折进「过程」；失败的那次照常归过程。 */

function ask(): TimelineItem {
  return { type: 'user_message', id: 'ask', turn: 0, at: 0, text: '给我三种输入框样式' }
}

function tool(
  id: string,
  invokedTool: string,
  kind: ToolKind,
  status: ToolCallStatus = 'completed',
): ToolCallTimelineItem {
  return {
    type: 'tool_call',
    id,
    turn: 0,
    at: 0,
    toolCallId: `call-${id}`,
    title: invokedTool,
    invokedTool,
    scheme: '',
    kind,
    headline: '',
    subject: '',
    shape: 'flow',
    status,
    requestContent: [],
    content: [],
    locations: [],
    channels: [],
    startedAt: 0,
    endedAt: 1,
  }
}

function thought(id: string): TimelineItem {
  return { type: 'agent_thought', id, turn: 0, at: 0, text: '先写三个方案', sealed: false }
}

function said(id: string): TimelineItem {
  return { type: 'agent_text', id, turn: 0, at: 0, text: '三种方案都放在上面了。', sealed: true }
}

/** 已落定的一轮（有运行事实 → 有封条，过程会折叠） */
function settled(items: readonly TimelineItem[]): TimelineState {
  return {
    status: 'idle',
    backgroundTasks: [],
    subagents: [],
    sealed: [],
    active: { turn: 0, run: { settled: true, undoCount: null, forkUnavailableReason: null }, items },
    lastSeq: 0,
    spans: [],
  }
}

function idsOf(state: TimelineState): string[] {
  const feed = selectPresentation(state, new Map())
  const ids: string[] = []
  for (let index = 0; index < feed.count; index += 1) {
    const row = feed.rowAt(index)
    if (row !== undefined) ids.push(row.item.id)
  }
  return ids
}

describe('组件在时间线里的位置（审查 R-18）', () => {
  it('落定后：前面的读文件折进过程，组件与答复都留在外面', () => {
    const state = settled([ask(), tool('r', 'read', 'read'), tool('w', 'show_widget', 'other'), said('a')])
    expect(idsOf(state)).toEqual(['ask', 'w', 'a'])
  })

  it('组件是最后一条（没有答复正文）：照样留在外面', () => {
    const state = settled([ask(), tool('r', 'read', 'read'), tool('w', 'show_widget', 'other')])
    expect(idsOf(state)).toEqual(['ask', 'w'])
  })

  it('展开这一轮时，紧挨着思考与同档工具也不并组：组件自己一行', () => {
    const state = settled([
      ask(),
      thought('t'),
      tool('o1', 'other_tool', 'other'),
      tool('w', 'show_widget', 'other'),
      tool('o2', 'other_tool', 'other'),
    ])
    const feed = selectPresentation(state, new Map([[0, true]]))
    const ids: string[] = []
    for (let index = 0; index < feed.count; index += 1) {
      const row = feed.rowAt(index)
      if (row !== undefined) ids.push(row.item.id)
      expect(feed.groupAt(index)?.members.map((member) => member.item.id) ?? []).not.toContain('w')
    }
    expect(ids).toEqual(['ask', 't', 'w', 'o2'])
    expect(feed.groupAt(1)?.members.map((member) => member.item.id)).toEqual(['t', 'o1'])
  })

  it('失败的那次照常归过程：落定后折起来', () => {
    const state = settled([
      ask(),
      tool('w', 'show_widget', 'other', 'failed'),
      tool('w2', 'show_widget', 'other'),
      said('a'),
    ])
    expect(idsOf(state)).toEqual(['ask', 'w2', 'a'])
  })
})
