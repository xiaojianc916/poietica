import { describe, expect, it } from 'bun:test'
import type { LinkTimelineItem, ToolCallTimelineItem } from '@poietica/agent'
import { renderToStaticMarkup } from 'react-dom/server'
import { LinkCard } from '../timeline/link-card'
import { ToolCallPanels } from '../timeline/tool-call-panels'

describe('工具调用的产品呈现', () => {
  it('计划只显示渲染后的计划正文', () => {
    const item: ToolCallTimelineItem = {
      type: 'tool_call',
      id: 'tool-plan',
      turn: 0,
      at: 0,
      toolCallId: 'plan-1',
      title: '计划',
      kind: 'plan',
      subject: '# 成都 5 天 4 晚休闲游',
      status: 'completed',
      requestContent: [{ type: 'prose', text: '# 成都 5 天 4 晚休闲游\n\n## 行程总览' }],
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      locations: [],
      channels: [],
      startedAt: 0,
      endedAt: 1,
    }

    const markup = renderToStaticMarkup(<ToolCallPanels isRunning={false} item={item} />)

    expect(markup).toContain('成都 5 天 4 晚休闲游')
    expect(markup).toContain('行程总览')
    expect(markup).not.toContain('Request')
    expect(markup).not.toContain('Response')
    expect(markup).not.toContain('>ok<')
  })

  it('重连状态不显示倒计时', () => {
    const item: LinkTimelineItem = {
      type: 'link',
      id: 'link-1',
      turn: 0,
      at: 0,
      link: {
        state: 'retrying',
        attempt: 4,
        of: 5,
        retryAt: Date.now() + 2_000,
        reason: 'offline',
      },
    }

    const markup = renderToStaticMarkup(
      <LinkCard isInFlight isOpen={false} item={item} onToggle={() => {}} />,
    )

    expect(markup).toContain('正在重新连接 4/5')
    expect(markup).not.toContain('后重试')
  })
})
