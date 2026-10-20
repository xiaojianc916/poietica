import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createAutomationToolCard } from '../automation-tool-card'

/* 折叠行与展开区：箭头只在真摊得开的时候出现；面板默认收起；「查看这次运行」是行尾的动作，
 * 不占展开区（否则一点行就多出一枚重复按钮）。 */

const LIST = JSON.stringify([
  {
    id: 'a1',
    title: '测试任务',
    prompt: '',
    enabled: true,
    schedule: { type: 'cron', cron: '0 9 * * *', timeZone: 'Asia/Shanghai' },
    nextRunAt: '2026-05-04T09:00:00+08:00',
    workspace: { id: 'ws1', name: 'poietica' },
    model: null,
    thinking: 'medium',
    posture: 'auto-edit',
    thread: 'new',
    notify: 'never',
    issue: null,
    lastRun: null,
  },
])

const RUN = JSON.stringify({ id: 'a1', title: '测试任务', run: { threadId: 't-run' } })

function mount(toolName: string, result: string): { readonly opened: string[] } {
  const opened: string[] = []
  const Card = createAutomationToolCard({
    useExists: () => true,
    openAutomation: () => undefined,
    runNow: () => undefined,
    openThread: (threadId) => {
      opened.push(threadId)
    },
    now: () => Date.parse('2026-05-04T08:00:00+08:00'),
  })
  const props: ToolCallRendererProps = {
    args: {},
    callId: 'call-1',
    result: { text: result },
    status: 'succeeded',
    threadId: 't1',
    toolName,
  }
  render(<Card {...props} />)
  return { opened }
}

afterEach(() => {
  cleanup()
})

describe('自动化工具卡', () => {
  test('面板默认收起；点行才展开', () => {
    mount('automation_list', LIST)

    expect(screen.queryByText('测试任务')).toBeNull()

    fireEvent.click(document.querySelector('.automation-tool__row') as Element)

    expect(screen.getByText('测试任务')).toBeDefined()
  })

  test('行上有展开箭头', () => {
    mount('automation_list', LIST)

    expect(document.querySelector('.timeline-row__chevron')).not.toBeNull()
  })

  test('「查看这次运行」在行尾，点它打开那次运行的对话', () => {
    const { opened } = mount('automation_run', RUN)

    const link = document.querySelector('.automation-tool__run-link')
    expect(link?.textContent).toContain('查看这次运行')

    fireEvent.click(link as Element)

    expect(opened).toEqual(['t-run'])
  })

  test('只有动作没有面板的那一步不给箭头', () => {
    mount('automation_run', RUN)

    expect(document.querySelector('.timeline-row__chevron')).toBeNull()
  })
})
