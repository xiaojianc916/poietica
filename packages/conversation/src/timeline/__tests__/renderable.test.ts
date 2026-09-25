import { describe, expect, it } from 'bun:test'
import { isRenderable } from '../renderable'
import type { TimelineItem } from '../timeline-contract'

// 上屏判据：抄成两份就会有两种「空」。只钉住一眼看不出来的分支。

function base(partial: Partial<TimelineItem>): TimelineItem {
  return { id: 'r0-x', at: 0, turn: 0, ...partial } as TimelineItem
}

function question(resolved: boolean): TimelineItem {
  return base({
    type: 'question',
    questionId: 'q-1',
    questions: [],
    ...(resolved ? { resolution: { outcome: 'answered', answers: {}, note: '' } } : {}),
  })
}

describe('isRenderable', () => {
  it('审批不进转录,答过也只是操作痕迹', () => {
    const item = base({
      type: 'permission',
      requestId: 'req-1',
      title: 'write',
    })

    expect(isRenderable(item)).toBe(false)
  })

  it('还没结清的题不进转录,结清了才留记录', () => {
    expect(isRenderable(question(false))).toBe(false)
    expect(isRenderable(question(true))).toBe(true)
  })

  it('推理与回答同一条判据', () => {
    expect(isRenderable(base({ type: 'agent_thought', text: '草稿' }))).toBe(true)
    expect(isRenderable(base({ type: 'agent_thought', text: '' }))).toBe(false)
  })

  it('空的一句话不是话', () => {
    expect(isRenderable(base({ type: 'user_message', text: '' }))).toBe(false)
    expect(isRenderable(base({ type: 'user_message', text: 'hi' }))).toBe(true)
    expect(isRenderable(base({ type: 'agent_text', text: '' }))).toBe(false)
  })

  it('报错总是上屏', () => {
    expect(isRenderable(base({ type: 'error', message: 'boom' }))).toBe(true)
  })
})
