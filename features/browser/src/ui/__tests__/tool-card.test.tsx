import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createBrowserToolCard } from '../tool-card'

/*
 * agent 那条线上的浏览器卡片。喂进去的是 **omp 18.5 真实的 eval 形状**：浏览器是 eval
 * 的 prelude，产出里只有 `details.statusEvents`（那句 `open main https://…`）与
 * `details.images[]`，入参只有 `{ language, code, title }`。
 *
 * 旧卡片读的是 `args.action / args.url` 与 `details.screenshots` —— 那是早期顶层 browser
 * 工具的形状，于是屏幕上只有一句「浏览器 main」和一枚按钮。这一组用例就是那个缺陷的钉子。
 */

const ARGS = {
  language: 'js',
  code: 'const t = await browser.open({ url: "https://a.com" })\nawait t.screenshot()',
  title: '看首页',
}

/** 一次 browser.open + screenshot 的产出：正本就是这一份。 */
const RESULT = {
  content: [{ type: 'text', text: 'ok' }],
  details: {
    statusEvents: [{ op: 'browser', detail: 'open main https://a.com' }],
    images: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
  },
}

function mount(
  over: {
    readonly args?: unknown
    readonly result?: unknown
    readonly status?: 'running' | 'succeeded' | 'failed'
  } = {},
) {
  const panel: string[] = []

  const Card = createBrowserToolCard({
    openPanel: () => {
      panel.push('browser.panel')
    },
  })

  render(
    <Card
      args={over.args === undefined ? ARGS : over.args}
      /* null 是「还没有产出」的正经取值，不能被兜底吃掉。 */
      result={over.result === undefined ? RESULT : over.result}
      status={over.status ?? 'succeeded'}
      threadId="t1"
      toolName="browser"
    />,
  )

  return { panel }
}

/** 展开卡片（折叠行就是那个按钮）。 */
function expand(): void {
  const row = document.querySelector('[data-browser-tool] button')

  if (row === null) {
    throw new Error('卡片没有折叠行')
  }

  fireEvent.click(row)
}

afterEach(() => {
  cleanup()
})

describe('折叠行', () => {
  test('一句话说清是哪一步：中文动作 + 目标', () => {
    mount()

    expect(screen.getByText(/浏览器 · 打开 https:\/\/a\.com/u)).toBeDefined()
  })

  test('多步时追加「等 N 步」', () => {
    mount({
      args: { language: 'js', code: 'x' },
      result: {
        content: [{ type: 'text', text: 'ok' }],
        details: {
          statusEvents: [
            { op: 'browser', detail: 'open main https://a.com' },
            { op: 'browser', detail: 'main.click("#go")' },
            { op: 'browser', detail: 'tabs' },
          ],
        },
      },
    })

    expect(screen.getByText(/等 3 步/u)).toBeDefined()
  })

  test('还没有状态事件时退回代码首行（0.2 的预判期间）', () => {
    mount({
      args: { language: 'js', code: 'await browser.open({ url: "https://a.com" })' },
      result: null,
      status: 'running',
    })

    expect(screen.getByText(/浏览器 · await browser\.open/u)).toBeDefined()
  })

  test('进行中与失败各有一枚状态', () => {
    mount({ status: 'running' })

    expect(screen.getByText('进行中')).toBeDefined()

    cleanup()
    mount({ status: 'failed' })

    expect(screen.getByText('失败')).toBeDefined()
  })
})

describe('展开区', () => {
  test('步骤、代码、截图都在；代码默认收起', () => {
    mount()
    expand()

    /* 步骤列表：这一步是打开 a.com。 */
    expect(screen.getAllByText(/https:\/\/a\.com/u).length).toBeGreaterThan(0)

    /* 代码默认收起，展开后能看到真正跑过的那两行。 */
    const code = document.querySelector('details')
    expect(code?.hasAttribute('open')).toBe(false)

    fireEvent.click(screen.getByText('代码'))
    expect(document.body.textContent).toContain('t.screenshot()')

    const image = document.querySelector('img')
    expect(image?.getAttribute('src')?.startsWith('data:image/png')).toBe(true)
  })

  test('截图点一下用原生 dialog 放大，再点关闭', () => {
    mount()
    expand()

    const thumb = document.querySelector('img')?.closest('button')

    if (thumb === null || thumb === undefined) {
      throw new Error('没有可点的缩略图')
    }

    fireEvent.click(thumb)

    expect(document.querySelector('dialog')?.open).toBe(true)

    fireEvent.click(screen.getByText('关闭'))

    expect(document.querySelector('dialog')).toBeNull()
  })

  test('失败时错误那段是红的', () => {
    mount({
      result: { content: [{ type: 'text', text: '选择器没找到\n\nat Object.click' }] },
      status: 'failed',
    })
    expand()

    const error = document.querySelector('[data-browser-error]')

    expect(error?.textContent).toBe('选择器没找到')
  })

  test('输出超过 12 行时先收着，能展开', () => {
    mount({
      result: {
        content: [{ type: 'text', text: Array.from({ length: 30 }, (_, at) => `第 ${String(at + 1)} 行`).join('\n') }],
      },
    })
    expand()

    expect(document.querySelector('[data-browser-output]')?.textContent).not.toContain('第 30 行')

    fireEvent.click(screen.getByText(/显示全部/u))

    expect(document.querySelector('[data-browser-output]')?.textContent).toContain('第 30 行')
  })
})

describe('在面板中查看', () => {
  test('点一下开面板', () => {
    const { panel } = mount()

    expand()
    fireEvent.click(screen.getByText('在面板中查看'))

    expect(panel).toEqual(['browser.panel'])
  })
})
