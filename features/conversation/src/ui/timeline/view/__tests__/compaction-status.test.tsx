import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { CompactionTimelineItem } from '../../../shared/timeline/timeline-contract'
import { CompactionStatus } from '../compaction-status'

/*
 * 压缩那一行与工具调用同一套长相（审查 R-21-3）：.timeline-tool > .timeline-row（字形 + 一句话 + 箭头），
 * 跑着时那句话走 timeline-shimmer，展开是同一个 .timeline-tool__panel。
 */

afterEach(cleanup)

const base: CompactionTimelineItem = { type: 'compaction', id: 'c1', turn: 1, at: 0, agentId: 'main', state: 'running' }

test('S1 跑着：工具行的结构 + 微光，没有可展开的东西就不是按钮', () => {
  const { container } = render(<CompactionStatus isOpen={false} item={base} onToggle={() => undefined} />)
  const row = container.querySelector('.timeline-tool > .timeline-row')
  expect(row?.tagName).toBe('DIV')
  expect(row?.querySelector('svg.timeline-row__icon')).not.toBeNull()
  const label = row?.querySelector('.timeline-row__label')
  expect(label?.textContent).toBe('正在压缩上下文…')
  expect(label?.classList.contains('timeline-shimmer')).toBe(true)
  // 旧的自绘字形不再出现
  expect(container.textContent).not.toContain('↻')
})

test('S2 做完：说出前后 token 数，不再微光；有摘要就能展开看', () => {
  let toggled = 0
  const item: CompactionTimelineItem = {
    ...base,
    state: 'completed',
    tokensBefore: 120_000,
    tokensAfter: 18_000,
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
  expect(label?.textContent).toBe(`已压缩上下文 · ${(120_000).toLocaleString()} → ${(18_000).toLocaleString()} tokens`)
  expect(label?.classList.contains('timeline-shimmer')).toBe(false)
  expect(view.container.querySelector('.timeline-tool__panel')).toBeNull()
  if (button) fireEvent.click(button)
  expect(toggled).toBe(1)

  view.rerender(<CompactionStatus isOpen item={item} onToggle={() => undefined} />)
  expect(view.container.querySelector('.timeline-tool__panel')?.textContent).toContain('摘要正文')
})

test('S3 失败与取消各说各的；失败原因在展开那一面', () => {
  const failed = render(
    <CompactionStatus isOpen item={{ ...base, state: 'failed', error: '没有可用模型' }} onToggle={() => undefined} />,
  )
  expect(failed.container.querySelector('.timeline-row__label')?.textContent).toBe('上下文压缩失败')
  expect(failed.container.querySelector('.timeline-tool__panel')?.textContent).toContain('没有可用模型')
  cleanup()

  const cancelled = render(
    <CompactionStatus isOpen={false} item={{ ...base, state: 'cancelled' }} onToggle={() => undefined} />,
  )
  expect(cancelled.container.querySelector('.timeline-row__label')?.textContent).toBe('上下文压缩已取消')
})
