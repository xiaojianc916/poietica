import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserToolCard } from '../tool-card'

/* 喂进去的是 omp 真实的 eval 形状：浏览器是 eval 的 prelude，产出里只有 details.statusEvents 与 details.images[]，入参只有
 * { language, code, title }。旧卡片读的是 args.action / args.url 与 details.screenshots（早期顶层 browser 工具的形状），屏幕上只剩一句
 * 「浏览器 main」和一枚按钮 —— 这一组用例就是那个缺陷的钉子。 */

const ARGS = {
  language: 'js',
  code: 'const t = await browser.open({ url: "https://a.com" })\nawait t.screenshot()',
  title: '看首页',
}

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
  const reported: string[] = []

  render(
    <BrowserToolCard
      args={over.args === undefined ? ARGS : over.args}
      callId="call-1"
      /** null 是「还没有产出」的正经取值，不能被兜底吃掉。 */
      result={over.result === undefined ? RESULT : over.result}
      status={over.status ?? 'succeeded'}
      threadId="t1"
      toolName="browser"
    />,
  )

  return { reported }
}

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

  test('多步时每一步各成一行，不并成「等 N 步」', () => {
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

    expect(screen.getByText(/浏览器 · 打开 https:\/\/a\.com/u)).toBeDefined()
    expect(screen.getByText(/浏览器 · 点击 #go/u)).toBeDefined()
    expect(screen.getByText(/浏览器 · 列出标签页/u)).toBeDefined()
    expect(document.querySelectorAll('[data-browser-step]')).toHaveLength(3)
    expect(screen.queryByText(/等 \d+ 步/u)).toBeNull()
  })

  test('还没有状态事件时退回代码首行（0.2 的预判期间）', () => {
    mount({
      args: { language: 'js', code: 'await browser.open({ url: "https://a.com" })' },
      result: null,
      status: 'running',
    })

    expect(screen.getByText(/浏览器 · await browser\.open/u)).toBeDefined()
  })

  test('只有「进行中」会显形', () => {
    mount({ status: 'running' })

    expect(screen.getByText('进行中')).toBeDefined()

    cleanup()
    mount({ status: 'failed' })

    expect(screen.queryByText('进行中')).toBeNull()
  })
})

describe('展开区', () => {
  test('展开就能看到代码，不再是第二层折叠', () => {
    mount()
    expand()

    expect(document.body.textContent).toContain('t.screenshot()')
  })

  test('截图那一步只有图片预览，且不在面板里', () => {
    mount({
      result: {
        content: [{ type: 'text', text: 'Screenshot captured\nFormat: image/png' }],
        details: {
          statusEvents: [
            { op: 'browser', detail: 'open main https://a.com' },
            { op: 'browser', detail: 'main.screenshot({fullPage:false})' },
          ],
          images: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        },
      },
    })

    const row = document.querySelectorAll('[data-browser-step]')[1]
    fireEvent.click(row as Element)

    const preview = document.querySelector('.browser-tool__preview')
    expect(preview?.querySelector('img')?.getAttribute('src')?.startsWith('data:image/png')).toBe(true)
    /* 截图那一步只给图：上游那句「Screenshot captured / Format: image/png」不是给人看的产出。 */
    expect(preview?.textContent).not.toContain('Screenshot captured')
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

  test('失败时错误只取正文第一段', () => {
    mount({
      result: { content: [{ type: 'text', text: '选择器没找到\n\nat Object.click' }] },
      status: 'failed',
    })
    expand()

    const error = document.querySelector('[data-browser-error]')

    expect(error?.textContent).toBe('选择器没找到')
  })

  test('产出一次给全，不再有「显示全部」', () => {
    mount({
      result: {
        content: [{ type: 'text', text: Array.from({ length: 30 }, (_, at) => `第 ${String(at + 1)} 行`).join('\n') }],
      },
    })
    expand()

    expect(document.querySelector('[data-browser-output]')?.textContent).toContain('第 30 行')
    expect(screen.queryByText(/显示全部/u)).toBeNull()
  })
})
