import { expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { Prose } from '../prose/prose'

/*
 * P-03：流式正文用批次波浪淡入，而不是 Streamdown 自带的逐字 span 动画。
 * 在旧实现（animated={REVEAL}）上 P1 失败：每个字一个 [data-sd-animate] span。
 * 节奏按 16ms 一帧、一次 3 字推进（接近真实流式）；在飞 span 只与「淡入窗口 / 到达间隔」有关。
 */
const PARA = '流式输出的时候，新到的文字应该像一道波一样淡入，前面的先变实，后面的跟上。'

const frame = () => new Promise((resolve) => setTimeout(resolve, 16))

test('P1 流式中不产生逐字 span；在飞的波浪 span 有上限', async () => {
  const { container, rerender } = render(<Prose streaming text="" />)
  let peak = 0
  for (let n = 3; n <= PARA.length * 4; n += 3) {
    await act(async () => {
      rerender(<Prose streaming text={PARA.repeat(4).slice(0, n)} />)
      await frame()
    })
    expect(container.querySelectorAll('[data-sd-animate]')).toHaveLength(0)
    peak = Math.max(peak, container.querySelectorAll('[data-wave-start]').length)
  }
  expect(peak).toBeGreaterThan(0)
  expect(peak).toBeLessThanOrEqual(40)
  cleanup()
})

test('P2 流式结束、最后一波淡完后摘掉插件：DOM 里不留任何标记', async () => {
  const { container, rerender } = render(<Prose streaming text="" />)
  await act(async () => rerender(<Prose streaming text={PARA} />))
  await act(async () => rerender(<Prose streaming={false} text={PARA} />))
  await act(() => new Promise((resolve) => setTimeout(resolve, 800)))
  expect(container.querySelectorAll('[data-wave-start],[data-wave-marker]')).toHaveLength(0)
  expect(container.textContent).toContain(PARA)
  cleanup()
})

test('P3 非流式（历史消息、static）从不挂插件', () => {
  const { container } = render(<Prose text={PARA} />)
  expect(container.querySelectorAll('[data-wave-start],[data-sd-animate]')).toHaveLength(0)
  cleanup()
})

test('P4 首帧已有的字不做动画（切回会话、虚拟列表重新挂载）', async () => {
  const { container } = render(<Prose streaming text={PARA} />)
  await act(async () => {})
  expect(container.querySelectorAll('[data-wave-start]')).toHaveLength(0)
  cleanup()
})
