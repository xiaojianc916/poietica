import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LinkCard } from '../surface/timeline/link-card'
import { ToolCallPanels } from '../surface/timeline/tool-call-panels'
import { TurnSeal, type TurnSealProps } from '../surface/timeline/turn-seal'
import type { LinkTimelineItem, ToolCallTimelineItem } from '../timeline/timeline-contract'

describe('工具调用的产品呈现', () => {
  it('只有一面的调用不挂切换条，纸就是它', () => {
    const item: ToolCallTimelineItem = {
      type: 'tool_call',
      id: 'tool-read',
      turn: 0,
      at: 0,
      toolCallId: 'read-1',
      title: 'read',
      kind: 'read',
      headline: '阅读 src/app.ts',
      subject: 'src/app.ts',
      shape: 'result',
      status: 'completed',
      requestContent: [],
      content: [{ type: 'command', command: 'const app = 1', language: 'typescript' }],
      locations: [],
      channels: [],
      startedAt: 0,
      endedAt: 1,
    }

    const markup = renderToStaticMarkup(<ToolCallPanels isRunning={false} item={item} />)

    expect(markup).toContain('const app = 1')
    expect(markup).not.toContain('输入')
    expect(markup).not.toContain('输出')
  })

  it('前后相接的两面摞在同一张纸上，不挂切换条', () => {
    const item: ToolCallTimelineItem = {
      type: 'tool_call',
      id: 'tool-bash',
      turn: 0,
      at: 0,
      toolCallId: 'bash-1',
      title: 'bash',
      kind: 'execute',
      headline: 'bun test',
      subject: 'bun test',
      shape: 'flow',
      status: 'completed',
      requestContent: [{ type: 'command', command: 'bun test', language: 'bash' }],
      content: [{ type: 'content', content: { type: 'text', text: '42 pass' } }],
      locations: [],
      channels: [],
      startedAt: 0,
      endedAt: 1,
    }

    const markup = renderToStaticMarkup(<ToolCallPanels isRunning={false} item={item} />)

    expect(markup).toContain('bun test')
    expect(markup).toContain('42 pass')
    expect(markup).toContain('data-seam')
    expect(markup).not.toContain('输入')
    expect(markup).not.toContain('输出')
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
