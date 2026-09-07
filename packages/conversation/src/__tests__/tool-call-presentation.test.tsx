import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LinkCard } from '../surface/timeline/link-card'
import { ToolCallPanels } from '../surface/timeline/tool-call-panels'
import { TurnSeal, type TurnSealProps } from '../surface/timeline/turn-seal'
import type { LinkTimelineItem, ToolCallTimelineItem } from '../timeline/timeline-contract'

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
describe('运行封条的独立事实', () => {
  const props: TurnSealProps = {
    turn: 0,
    durationMs: undefined,
    startedAt: undefined,
    endedAt: undefined,
    lastFrameAt: undefined,
    hasProcess: false,
    isRunning: false,
    isOpen: false,
    onToggle: () => {},
  }
  it('无过程仍有封条，只说阶段，不是按钮', () => {
    const markup = renderToStaticMarkup(<TurnSeal {...props} />)
    expect(markup).toContain('已处理')
    expect(markup).not.toMatch(/\d/)
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('aria-expanded')
  })
  it('冷恢复只有 durationMs 也显示时间,包含零与亚秒', () => {
    for (const durationMs of [0, 500, 2500]) {
      const markup = renderToStaticMarkup(<TurnSeal {...props} durationMs={durationMs} />)
      expect(markup).toMatch(/\d/)
    }
  })
  it('没有终点时不拿最后观察时间冒充总耗时', () => {
    const markup = renderToStaticMarkup(<TurnSeal {...props} lastFrameAt={3000} startedAt={1000} />)
    expect(markup).not.toMatch(/\d/)
    const known = renderToStaticMarkup(<TurnSeal {...props} endedAt={3000} startedAt={1000} />)
    expect(known).toMatch(/\d/)
  })
  it('有过程时展开状态来自同一投影,不要求计时存在', () => {
    for (const isOpen of [false, true]) {
      const markup = renderToStaticMarkup(<TurnSeal {...props} hasProcess isOpen={isOpen} />)
      expect(markup).toContain(`aria-expanded="${String(isOpen)}"`)
    }
    const running = renderToStaticMarkup(<TurnSeal {...props} hasProcess isOpen isRunning />)
    expect(running).not.toContain('<button')
  })
})
