import { describe, expect, it } from 'vitest'
import { isRenderable } from '../renderable'
import type { TimelineItem } from '../timeline-contract'

/*
 * 上屏判据。
 *
 * 这个文件守的是 renderable.ts 头注释里那句「决定只在这里做一次」：抄成两份就会
 * 有两种「空」—— 屏幕上什么都没有、reducer 却认为这一轮有产出。
 *
 * 此处只钉住那些「一眼看不出来」的分支；一眼看得出来的（工具调用、消息）由
 * 类型系统看着，不需要断言。
 */

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
      options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }],
    })

    expect(isRenderable(item)).toBe(false)
  })

  it('还没结清的题不进转录,结清了才留记录', () => {
    expect(isRenderable(question(false))).toBe(false)
    expect(isRenderable(question(true))).toBe(true)
  })

  it('推理不上屏', () => {
    expect(isRenderable(base({ type: 'agent_thought', text: '草稿' }))).toBe(false)
  })

  it('空的一句话不是话', () => {
    expect(isRenderable(base({ type: 'user_message', text: '' }))).toBe(false)
    expect(isRenderable(base({ type: 'user_message', text: 'hi' }))).toBe(true)
    expect(isRenderable(base({ type: 'agent_text', text: '' }))).toBe(false)
  })

  it('空计划不上屏', () => {
    expect(isRenderable(base({ type: 'plan', entries: [] }))).toBe(false)
    expect(
      isRenderable(base({ type: 'plan', entries: [{ content: 'x', status: 'pending' }] })),
    ).toBe(true)
  })

  it('报错总是上屏', () => {
    expect(isRenderable(base({ type: 'error', message: 'boom' }))).toBe(true)
  })
})
