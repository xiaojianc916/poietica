import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { RetryTimelineItem } from '../../../shared/timeline/timeline-contract'
import { RetryStatus } from '../retry-status'

/*
 * 自动重试那一行与工具调用同一套结构：.timeline-tool > .timeline-row（字形 + 一句话 + 箭头）；
 * 展开按请求先后列报错，连着相同的合成一条。
 */

afterEach(cleanup)

const base: RetryTimelineItem = {
  type: 'retry',
  id: 'r1',
  turn: 1,
  at: 0,
  state: 'running',
  attempt: 2,
  maxAttempts: 5,
  errors: ['rate limited', 'rate limited'],
}

const labelIn = (container: HTMLElement) => container.querySelector('.timeline-row__label')

test('S1 在重试：读作「正在重试 2/5」', () => {
  const { container } = render(<RetryStatus isOpen={false} item={base} onToggle={() => undefined} />)
  expect(container.querySelector('.timeline-tool > button.timeline-row')).not.toBeNull()
  expect(labelIn(container)?.textContent).toBe('正在重试 2/5')
})

test('S2 收口的几种说法', () => {
  const cases: [Partial<RetryTimelineItem>, string][] = [
    [{ state: 'failed', attempt: 5 }, '重试 5 次仍失败'],
    [{ state: 'failed', attempt: 0 }, '请求失败'],
    [{ state: 'cancelled', attempt: 1 }, '已停止重试'],
  ]
  for (const [patch, label] of cases) {
    const { container, unmount } = render(
      <RetryStatus isOpen={false} item={{ ...base, ...patch }} onToggle={() => undefined} />,
    )
    expect(labelIn(container)?.textContent).toBe(label)
    unmount()
  }
})

test('S3 展开：连着相同的报错合成一条，标明是第几次请求', () => {
  const item: RetryTimelineItem = { ...base, state: 'failed', attempt: 5, errors: ['a', 'a', 'a', 'b', 'b', 'c'] }
  const { container } = render(<RetryStatus isOpen item={item} onToggle={() => undefined} />)
  const entries = [...container.querySelectorAll('.timeline-retry-status__entry')].map((entry) => [
    entry.querySelector('.timeline-retry-status__when')?.textContent,
    entry.querySelector('.timeline-retry-status__error')?.textContent,
  ])
  expect(entries).toEqual([
    ['第 1–3 次请求', 'a'],
    ['第 4–5 次请求', 'b'],
    ['第 6 次请求', 'c'],
  ])
  expect(container.querySelector('.timeline-retry-status__caption')?.textContent).toBe('6 次请求失败')
})

test('S4 点行切换展开；一条报错都没有就只是一行状态，不是按钮', () => {
  let toggled = 0
  const { container, rerender } = render(<RetryStatus isOpen={false} item={base} onToggle={() => (toggled += 1)} />)
  const button = container.querySelector('button.timeline-row')
  expect(button?.getAttribute('aria-expanded')).toBe('false')
  if (button !== null) fireEvent.click(button)
  expect(toggled).toBe(1)

  rerender(<RetryStatus isOpen={false} item={{ ...base, errors: [] }} onToggle={() => undefined} />)
  expect(container.querySelector('button.timeline-row')).toBeNull()
  expect(container.querySelector('.timeline-tool > div.timeline-row')).not.toBeNull()
})
