import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Presentation } from '../../presentation'
import { AgentActivityFeed, type FeedPort } from '../agent-activity-feed'

/*
 * happy-dom 没有布局：行高、视口高由 offsetHeight 桩给出（行高写在行内容的 data-h 上），
 * ResizeObserver 永远不回调 —— 正好钉住「不能等它下一帧」的那两条。真实布局下的逐帧位置见 R-39。
 */

interface LabRow {
  readonly id: string
  readonly h: number
}

const VIEWPORT_PX = 400
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const realScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
const realClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
const isViewport = (element: Element) => element.classList.contains('agent-activity-feed__viewport')
const realStyle = window.getComputedStyle.bind(window)

function heightOf(element: HTMLElement): number {
  if (element.classList.contains('agent-activity-feed__viewport')) return VIEWPORT_PX
  const own = element.querySelector<HTMLElement>('[data-h]')

  return element.classList.contains('agent-activity-feed__row') && own !== null ? Number(own.dataset.h) : 0
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return heightOf(this)
    },
  })
  /* 视口能滚多远：转录盒的行内高度（虚拟器给的 total）+ 上沿留白 */
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      const transcript = this.querySelector<HTMLElement>('.agent-activity-feed__transcript')
      return isViewport(this) && transcript !== null ? 24 + Number.parseFloat(transcript.style.height || '0') : 0
    },
  })
  /*
   * `clientHeight` 必须挂在 HTMLElement.prototype：happy-dom 的真实 getter 就在那一层，
   * 挂到 Element.prototype 只是新增了一个实例取不到的属性，桩等于没写 —— 虚拟器读到的视口高
   * 一直是 0，calculateRange 返回 null、一行都不渲染，total 退化成估算值（曾静默跑红两条断言）。
   */
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isViewport(this) ? VIEWPORT_PX : 0
    },
  })
  /* 令牌与视口上沿留白：真实值由设计令牌给，这里只要「两档跑道不一样长、上沿有留白」。 */
  window.getComputedStyle = ((element: Element) => {
    const style = realStyle(element)

    if (!(element instanceof HTMLElement) || !element.classList.contains('agent-activity-feed__viewport')) return style

    const tokens: Record<string, string> = { '--cp-dock-dissolve': '39px', '--cp-dock-gap': '8px' }

    return new Proxy(style, {
      get(target, key) {
        if (key === 'getPropertyValue') return (name: string) => tokens[name] ?? target.getPropertyValue(name)
        if (key === 'paddingBlockStart') return '24px'
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }) as typeof window.getComputedStyle
})

afterEach(() => {
  cleanup()
  if (realOffsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight)
  if (realScrollHeight !== undefined) Object.defineProperty(Element.prototype, 'scrollHeight', realScrollHeight)
  if (realClientHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientHeight', realClientHeight)
  window.getComputedStyle = realStyle
})

function feedOf(rows: readonly LabRow[]): Presentation {
  const where = new Map(rows.map((row, index) => [row.id, index]))

  return {
    count: rows.length,
    latestOwnMessage: null,
    rowAt: (index: number) => {
      const row = rows[index]
      return row === undefined
        ? undefined
        : { item: { id: row.id, type: 'agent_text', turn: 0 }, isStreamingTail: false, isInFlight: false }
    },
    rowOf: (id: string) => where.get(id),
  } as unknown as Presentation
}

function feed(rows: readonly LabRow[], trailing: ReactNode, port?: (port: FeedPort) => void) {
  return (
    <AgentActivityFeed
      conversation="lab"
      disclosed={NOTHING}
      dockClearance={0}
      estimateRow={() => 50}
      feed={feedOf(rows)}
      hasEarlier={false}
      isBusy={false}
      onReachStart={async () => {}}
      overlay={(handle) => {
        port?.(handle)
        return null
      }}
      renderRow={(index) => <div data-h={rows[index]?.h} />}
      rowRhythm={() => 'prose'}
      trailing={trailing}
    />
  )
}

const NOTHING = {}

const transcriptHeight = (container: HTMLElement) =>
  Number.parseFloat(container.querySelector<HTMLElement>('.agent-activity-feed__transcript')?.style.height ?? '')

test('一轮结束：跑道收掉与回复底下长出的那一截在同一次提交里结清，不等 ResizeObserver 下一帧', async () => {
  const running = [
    { id: 'q', h: 60 },
    { id: 'a', h: 200 },
  ]
  const { container, rerender } = render(feed(running, <span>运行中</span>))

  expect(transcriptHeight(container)).toBe(60 + 200 + 39)

  /* 结束那一刻：运行行撤掉（跑道 39 → 8），回复底下长出 32px 的操作条 */
  await act(async () => {
    rerender(feed([running[0]!, { id: 'a', h: 232 }], undefined))
  })

  expect(transcriptHeight(container)).toBe(60 + 232 + 8)
})

test('跳到某一轮：那一行落在视口上沿留白处（与滚到顶时第一行同一个位置），落定后不再挪', async () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: `r${String(index)}`, h: 100 }))
  let port: FeedPort | null = null
  const { container } = render(
    feed(rows, undefined, (handle) => {
      port = handle
    }),
  )
  const viewport = container.querySelector<HTMLElement>('.agent-activity-feed__viewport')!

  await act(async () => {
    ;(port as FeedPort | null)?.scrollToRow(10)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  const start = container.querySelector<HTMLElement>('.agent-activity-feed__transcript')!.offsetTop + 10 * 100

  expect(viewport.scrollTop).toBe(start - 24)

  await act(async () => {
    viewport.dispatchEvent(new Event('scrollend'))
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  expect(viewport.scrollTop).toBe(start - 24)
})
