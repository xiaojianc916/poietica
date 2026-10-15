import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import type { TurnOutcome } from '../../../timeline/timeline-contract'
import { TurnSeal } from '../turn-seal'

/*
 * 封条：文案三档由「怎么结束的」解出，打断与出错不报时长、且不可折叠。
 * 「什么时候封 / 什么时候不封」的投影判据在 turn-seal-plan.test.ts 里钉。
 */

afterEach(() => {
  cleanup()
})

interface Overrides {
  readonly outcome?: TurnOutcome | undefined
  readonly canCollapse?: boolean
  readonly durationMs?: number | undefined
  readonly startedAt?: number | undefined
  readonly endedAt?: number | undefined
}

function mount(overrides: Overrides = {}): HTMLElement {
  const { container } = render(
    <TurnSeal
      canCollapse={overrides.canCollapse ?? false}
      durationMs={overrides.durationMs}
      /* `in` 而不是 `??`：显式传 undefined 是「没有这个事实」，与「没传」要分开。 */
      endedAt={'endedAt' in overrides ? overrides.endedAt : 10_000}
      isOpen={false}
      onToggle={() => undefined}
      outcome={overrides.outcome ?? 'completed'}
      startedAt={overrides.startedAt ?? 0}
      turn={0}
    />,
  )

  return container
}

const labelOf = (container: HTMLElement): string => container.querySelector('.turn-seal__label')?.textContent ?? ''

describe('封条的文案三档', () => {
  it('正常答完：报「已完成，用时 N」', () => {
    expect(labelOf(mount({ durationMs: 4_000, outcome: 'completed' }))).toBe('已完成，用时 4秒')
  })

  it('被人叫停：报「已停止」，不报时长', () => {
    const container = mount({ durationMs: 4_000, outcome: 'aborted' })

    expect(labelOf(container)).toBe('已停止')
    expect(container.textContent).not.toContain('用时')
  })

  it('自己坏了：报「处理失败」，不报时长', () => {
    expect(labelOf(mount({ outcome: 'error', durationMs: 4_000 }))).toBe('处理失败')
  })

  it('agent 没报总时长时用两头相减兜底', () => {
    const container = mount({ durationMs: undefined, endedAt: 7_000, outcome: 'completed', startedAt: 3_000 })

    expect(labelOf(container)).toBe('已完成，用时 4秒')
  })

  it('agent 报的总时长优先于两头相减：那两个时刻只覆盖到最后一跳', () => {
    const container = mount({ durationMs: 9_000, endedAt: 7_000, outcome: 'completed', startedAt: 3_000 })

    expect(labelOf(container)).toBe('已完成，用时 9秒')
  })

  it('轮没有报终局（老载荷）：按正常答完算，不编一个「失败」出来', () => {
    const container = mount({ durationMs: 2_000, outcome: undefined })

    expect(labelOf(container)).toBe('已完成，用时 2秒')
    expect(container.querySelector('.turn-seal__announce')?.textContent).toBe('已完成')
  })

  it('时长缺席时只报那一档，不报「用时」两个字', () => {
    expect(
      labelOf(mount({ durationMs: undefined, endedAt: undefined, outcome: 'completed', startedAt: undefined })),
    ).toBe('已完成')
  })

  it('不足一秒也报 1 秒：屏幕上不出现「0秒」', () => {
    expect(labelOf(mount({ durationMs: 0, outcome: 'completed', startedAt: 0, endedAt: 0 }))).toBe('已完成，用时 1秒')
  })
})

describe('封条的折叠', () => {
  it('能折叠时是按钮，带 aria-expanded', () => {
    const container = mount({ canCollapse: true })

    expect(container.querySelector('button.turn-seal--toggle')).not.toBeNull()
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('不能折叠时是纯文字：不为一个点了没反应的开关画一个按钮', () => {
    const container = mount({ canCollapse: false })

    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('p.turn-seal')).not.toBeNull()
  })
})

describe('封条的读屏播报', () => {
  it('播报结论那一句，不带每秒在变的数字', () => {
    const container = mount({ canCollapse: true, durationMs: 5_000 })
    const announce = container.querySelector('.turn-seal__announce')

    expect(announce?.textContent).toBe('已完成')
    expect(announce?.getAttribute('role')).toBe('status')
  })

  it('出错时播报「处理失败」', () => {
    expect(mount({ outcome: 'error' }).querySelector('.turn-seal__announce')?.textContent).toBe('处理失败')
  })
})
