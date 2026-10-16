import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { StrictMode } from 'react'
import type { TurnMark } from '../../../shared/model/thread'
import { ConversationMinimap } from '../conversation-minimap'
import { RAIL_PITCH_PX } from '../conversation-minimap-geometry'

/* happy-dom 不跑 CSS transition；这里钉住整段退场动画依赖的 DOM：撤掉显示标记，但不换正文。
 * 使用真实 useRailPointer，仅替换布局读数和帧队列，避免测试直接驱动内部状态。 */
let frames = new Map<number, FrameRequestCallback>()
let nextHandle = 0
const realRaf = window.requestAnimationFrame
const realCancel = window.cancelAnimationFrame
const marks: readonly TurnMark[] = [
  { admissionId: 'a1', turnId: 't1', prompt: '第一轮问题', reply: '第一轮回答' },
  { admissionId: 'a2', turnId: 't2', prompt: '第二轮问题', reply: '第二轮回答' },
  { admissionId: 'a3', turnId: 't3', prompt: '第三轮问题', reply: '第三轮回答' },
]
const ignoreSelect = () => undefined

beforeEach(() => {
  frames = new Map()
  nextHandle = 0
  window.requestAnimationFrame = (callback) => {
    nextHandle += 1
    frames.set(nextHandle, callback)
    return nextHandle
  }
  window.cancelAnimationFrame = (handle) => {
    frames.delete(handle)
  }
})

afterEach(() => {
  cleanup()
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCancel
})

function nextFrame() {
  act(() => {
    const due = [...frames.values()]
    frames.clear()
    for (const callback of due) callback(0)
  })
}

function mount(initial: readonly TurnMark[] = marks) {
  const content = (rows: readonly TurnMark[]) => (
    <StrictMode>
      <ConversationMinimap activeId="a1" busyId={null} marks={rows} onSelect={ignoreSelect} />
    </StrictMode>
  )
  const view = render(content(initial))
  const nav = view.getByRole('navigation')
  const scroller = nav.querySelector<HTMLDivElement>('.conversation-minimap__scroller')!
  const card = nav.querySelector<HTMLDivElement>('.conversation-minimap__card')!
  nav.getBoundingClientRect = () => new DOMRect(100, 0, 34, 300)
  scroller.getBoundingClientRect = () => new DOMRect(100, 100, 34, initial.length * RAIL_PITCH_PX)
  for (const [index, bar] of view.getAllByRole('button').entries()) {
    bar.getBoundingClientRect = () => new DOMRect(100, 100 + index * RAIL_PITCH_PX, 34, RAIL_PITCH_PX)
  }
  const hover = (index: number) => {
    fireEvent.pointerMove(window, { clientX: 110, clientY: 100 + (index + 0.5) * RAIL_PITCH_PX })
    nextFrame()
  }
  const leave = () => {
    fireEvent.pointerMove(window, { clientX: 500, clientY: 106 })
    nextFrame()
  }
  return { ...view, card, hover, leave, update: (rows: readonly TurnMark[]) => view.rerender(content(rows)) }
}

function expectPreview(card: HTMLElement, mark: TurnMark, shown: boolean) {
  expect(card.hasAttribute('data-shown')).toBe(shown)
  expect(card.querySelector('.conversation-minimap__card-question')?.textContent).toBe(mark.prompt.trim())
  expect(card.querySelector('.conversation-minimap__card-reply')?.textContent).toBe(mark.reply?.trim())
}

test('M1 初次挂载没有假轮次；不足两轮不显示导航', () => {
  const view = mount()
  expect(view.card.hasAttribute('data-shown')).toBe(false)
  expect(view.card.textContent).toBe('')
  view.update(marks.slice(0, 1))
  expect(view.queryByRole('navigation')).toBeNull()
})

test('M2 离开命中区只隐藏卡片，后续渲染也保留真实正文', () => {
  const view = mount()
  view.hover(0)
  expectPreview(view.card, marks[0]!, true)
  view.leave()
  expectPreview(view.card, marks[0]!, false)
  view.update([...marks])
  nextFrame()
  expectPreview(view.card, marks[0]!, false)
  expect(view.card.textContent).not.toContain('未命名轮次')
  expect(view.card.textContent).not.toContain('暂无文本回复')
})

test('M3 退场中快速移入另一轮，立即换成新内容；再次离开保留新轮', () => {
  const view = mount()
  view.hover(0)
  view.leave()
  view.hover(1)
  expectPreview(view.card, marks[1]!, true)
  view.leave()
  nextFrame()
  expectPreview(view.card, marks[1]!, false)
})

test('M4 悬浮期间的流式更新同步显示，退出保留最后一版', () => {
  const view = mount()
  view.hover(0)
  const latest = { ...marks[0]!, reply: '第一轮回答，流式追加完成' }
  view.update([latest, ...marks.slice(1)])
  expectPreview(view.card, latest, true)
  view.leave()
  expectPreview(view.card, latest, false)
})

test('M5 退场后列表回填，保留快照而不是拿旧下标读取另一轮', () => {
  const view = mount()
  view.hover(1)
  view.leave()
  view.update([marks[2]!, marks[0]!, marks[1]!])
  expectPreview(view.card, marks[1]!, false)
})

test('M6 当前轮被移除也正常退场，不显示无效轮次占位', () => {
  const view = mount()
  view.hover(2)
  view.update(marks.slice(0, 2))
  expectPreview(view.card, marks[2]!, false)
})

test('M7 真实空轮次仍使用原有占位文案，不能用删除文案掩盖闪烁', () => {
  const empty: TurnMark = { ...marks[1]!, prompt: '  ', reply: null }
  const view = mount([marks[0]!, empty])
  view.hover(0)
  view.hover(1)
  expect(view.card.hasAttribute('data-shown')).toBe(true)
  expect(view.card.querySelector('.conversation-minimap__card-question')?.textContent).toBe('未命名轮次')
  expect(view.card.querySelector('.conversation-minimap__card-reply')?.textContent).toBe('暂无文本回复')
})

test.each(['pointerleave', 'blur'])('M8 %s 退场同样保留内容', (event) => {
  const view = mount()
  view.hover(1)
  fireEvent(event === 'blur' ? window : document, new Event(event))
  nextFrame()
  expectPreview(view.card, marks[1]!, false)
})

test('M9 键盘焦点退出同样保留内容', () => {
  const view = mount()
  const button = view.getAllByRole('button')[1]!
  // happy-dom 不模拟键盘输入模态，这次焦点按 :focus-visible 处理。
  const focusVisible = spyOn(button, 'matches').mockReturnValue(true)
  try {
    fireEvent.focusIn(button)
    expectPreview(view.card, marks[1]!, true)
    fireEvent.focusOut(button)
    expectPreview(view.card, marks[1]!, false)
  } finally {
    focusVisible.mockRestore()
  }
})
