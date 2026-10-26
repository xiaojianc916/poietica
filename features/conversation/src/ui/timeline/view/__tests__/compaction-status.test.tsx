import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { CompactionTimelineItem } from '../../../shared/timeline/timeline-contract'
import { CompactionStatus } from '../compaction-status'

/*
 * 压缩那一行与工具调用同一套结构（审查 R-21-3）：.timeline-tool > .timeline-row（字形 + 一句话 + 箭头），
 * 展开是同一个 .timeline-tool__panel。
 * U-04：一行只说结果（「上下文已压缩 39.9K → 23.7K」，不写 tokens 与千分位），摘要默认收着；交接单独一种说法，可复制。
 */

afterEach(cleanup)

const base: CompactionTimelineItem = { type: 'compaction', id: 'c1', turn: 1, at: 0, agentId: 'main', state: 'running' }

const labelIn = (container: HTMLElement): string | null | undefined =>
  container.querySelector('.timeline-row__label')?.textContent

test('S1 跑着：工具行的结构，没有可展开的东西就不是按钮', () => {
  const { container } = render(<CompactionStatus isOpen={false} item={base} onToggle={() => undefined} />)
  const row = container.querySelector('.timeline-tool > .timeline-row')
  expect(row?.tagName).toBe('DIV')
  const label = row?.querySelector('.timeline-row__label')
  expect(label?.textContent).toBe('正在压缩上下文…')
  // 旧的自绘字形不再出现
  expect(container.textContent).not.toContain('↻')
})

test('S2 做完：一行短写前后两个数，不再微光；默认收着，展开先一句说明再给摘要', () => {
  let toggled = 0
  const item: CompactionTimelineItem = {
    ...base,
    state: 'completed',
    tokensBefore: 39_919,
    tokensAfter: 23_710,
    summary: '摘要正文',
  }
  const view = render(
    <CompactionStatus
      isOpen={false}
      item={item}
      onToggle={() => {
        toggled += 1
      }}
    />,
  )
  const button = view.container.querySelector('button.timeline-row')
  expect(button?.getAttribute('aria-expanded')).toBe('false')
  const label = button?.querySelector('.timeline-row__label')
  expect(label?.textContent).toBe('上下文已压缩 39.9K → 23.7K')
  expect(view.container.querySelector('.timeline-tool__panel')).toBeNull()
  if (button) fireEvent.click(button)
  expect(toggled).toBe(1)

  view.rerender(<CompactionStatus isOpen item={item} onToggle={() => undefined} />)
  const panel = view.container.querySelector('.timeline-tool__panel')
  expect(panel?.querySelector('.timeline-compaction__caption')?.textContent).toBe('较早的对话已替换为这份摘要。')
  expect(panel?.textContent).toContain('摘要正文')
  expect(panel?.querySelector('button[aria-label="复制摘要"]')).not.toBeNull()
})

test('S3 失败与取消各说各的；失败原因在展开那一面', () => {
  const failed = render(
    <CompactionStatus isOpen item={{ ...base, state: 'failed', error: '没有可用模型' }} onToggle={() => undefined} />,
  )
  expect(labelIn(failed.container)).toBe('上下文压缩失败')
  expect(failed.container.querySelector('.timeline-tool__panel')?.textContent).toContain('没有可用模型')
  cleanup()

  const cancelled = render(
    <CompactionStatus isOpen={false} item={{ ...base, state: 'cancelled' }} onToggle={() => undefined} />,
  )
  expect(labelIn(cancelled.container)).toBe('已取消压缩')
})

test('S4 交接：跑着说「正在生成交接文档」，做完说「已交接」，展开说明交接文档已是上下文、可复制', () => {
  const running = render(
    <CompactionStatus isOpen={false} item={{ ...base, handoff: true }} onToggle={() => undefined} />,
  )
  expect(labelIn(running.container)).toBe('正在生成交接文档…')
  cleanup()

  const done = render(
    <CompactionStatus
      isOpen
      item={{
        ...base,
        handoff: true,
        state: 'completed',
        tokensBefore: 120_000,
        tokensAfter: 8_000,
        summary: '# Handoff',
      }}
      onToggle={() => undefined}
    />,
  )
  expect(labelIn(done.container)).toBe('已交接 · 上下文 120K → 8K')
  expect(done.container.querySelector('.timeline-compaction__caption')?.textContent).toBe(
    '之后的对话以这份交接文档为上下文继续。',
  )
  expect(done.container.querySelector('button[aria-label="复制交接文档"]')).not.toBeNull()
})

test('S5 被后一次压缩取代的摘要：照实说，不给复制', () => {
  const { container } = render(
    <CompactionStatus
      isOpen
      item={{ ...base, state: 'completed', superseded: true, tokensBefore: 50_000 }}
      onToggle={() => undefined}
    />,
  )
  expect(labelIn(container)).toBe('上下文已压缩（原 50K）')
  expect(container.querySelector('.timeline-compaction__caption')?.textContent).toBe('这份摘要已被后一次压缩取代。')
  expect(container.querySelector('.timeline-compaction__copy')).toBeNull()
})
