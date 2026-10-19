import { describe, expect, it } from 'bun:test'
import type { ToolCallStatus, ToolKind } from '../../../shared/model/tool-call'
import type { TimelineItem, TimelineState, ToolCallTimelineItem } from '../../../shared/timeline/timeline-contract'
import { inlineToolsOf, selectPresentation } from '../../presentation'

/* 贡献了 inline 卡片的工具（例如 intelligent-ui 的 intelligent_ui，原 R-18 的 show_widget）不并进过程组，落定后也不折进「过程」；失败的那次照常归过程。
 * 判据来自贡献，conversation 不认识具体工具名：没有贡献时 intelligent_ui 就是一件普通工具。 */

const INLINE = inlineToolsOf([{ toolName: 'intelligent_ui', inline: true, component: () => null }])

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
    todos: [],
    backgroundTasks: [],
    subagents: [],
    sealed: [],
    active: { turn: 0, run: { settled: true, keepTurns: null, forkUnavailableReason: null }, items },
    spans: [],
  }
}

function idsOf(state: TimelineState): string[] {
  const feed = selectPresentation(state, new Map(), INLINE)
  const ids: string[] = []
  for (let index = 0; index < feed.count; index += 1) {
    const row = feed.rowAt(index)
    if (row !== undefined) ids.push(row.item.id)
  }
  return ids
}

describe('组件在时间线里的位置（审查 R-18）', () => {
  it('落定后：前面的读文件折进过程，组件与答复都留在外面', () => {
    const state = settled([ask(), tool('r', 'read', 'read'), tool('w', 'intelligent_ui', 'other'), said('a')])
    expect(idsOf(state)).toEqual(['ask', 'w', 'a'])
  })

  it('没有功能贡献 inline 卡片时，intelligent_ui 只是一件普通工具：落定后照常折进过程', () => {
    const state = settled([ask(), tool('r', 'read', 'read'), tool('w', 'intelligent_ui', 'other'), said('a')])
    const feed = selectPresentation(state, new Map())
    const ids: string[] = []
    for (let index = 0; index < feed.count; index += 1) {
      const row = feed.rowAt(index)
      if (row !== undefined) ids.push(row.item.id)
    }
    expect(ids).toEqual(['ask', 'a'])
  })

  it('判据认正则贡献；只认 inline: true 的卡片', () => {
    const inline = inlineToolsOf([
      { toolName: /^canvas_/, inline: true, component: () => null },
      { toolName: 'browser', component: () => null },
    ])
    expect(inline('canvas_draw')).toBe(true)
    expect(inline('browser')).toBe(false)
    expect(inline('intelligent_ui')).toBe(false)
  })

  it('组件是最后一条（没有答复正文）：照样留在外面', () => {
    const state = settled([ask(), tool('r', 'read', 'read'), tool('w', 'intelligent_ui', 'other')])
    expect(idsOf(state)).toEqual(['ask', 'w'])
  })

  it('展开这一轮时，紧挨着思考与同档工具也不并组：组件自己一行', () => {
    const state = settled([
      ask(),
      thought('t'),
      tool('o1', 'other_tool', 'other'),
      tool('w', 'intelligent_ui', 'other'),
      tool('o2', 'other_tool', 'other'),
    ])
    const feed = selectPresentation(state, new Map([[0, true]]), INLINE)
    const ids: string[] = []
    for (let index = 0; index < feed.count; index += 1) {
      const row = feed.rowAt(index)
      if (row !== undefined) ids.push(row.item.id)
      expect(feed.groupAt(index)?.members.map((member) => member.item.id) ?? []).not.toContain('w')
    }
    /* 成组只数工具：思考 + 一条 o1 不成组，落定的思考丢掉，o1 自己一行。 */
    expect(ids).toEqual(['ask', 'o1', 'w', 'o2'])
    expect(feed.groupAt(1)).toBeUndefined()
  })

  it('失败的那次照常归过程：落定后折起来', () => {
    const state = settled([
      ask(),
      tool('w', 'intelligent_ui', 'other', 'failed'),
      tool('w2', 'intelligent_ui', 'other'),
      said('a'),
    ])
    expect(idsOf(state)).toEqual(['ask', 'w2', 'a'])
  })
})
