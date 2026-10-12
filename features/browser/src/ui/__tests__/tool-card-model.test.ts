import { describe, expect, test } from 'bun:test'
import { browserCallModel, parseStep } from '../tool-card-model'

/*
 * 卡片的数据层。浏览器在 omp 18.5 里是 eval 的 prelude，产出形状是
 * `{ content: [...], details: { statusEvents, cells[].statusEvents, images } }`，
 * 入参是 `{ language, code, title }` —— 这里逐条钉住每一种形状。
 *
 * 纯函数，不挂 React：形状有二十来种，走渲染去验证每一种要多写十倍断言，
 * 而且分不清是解析错了还是画错了。
 */

const evalArgs = (over: Record<string, unknown> = {}): unknown => ({
  language: 'js',
  code: 'await browser.open({ url: "https://a.com" })',
  ...over,
})

describe('parseStep：上游那句 detail → 一步', () => {
  test('open 带与不带地址', () => {
    expect(parseStep('open main https://a.com')).toEqual({
      action: 'open',
      tab: 'main',
      target: 'https://a.com',
      said: 'open main https://a.com',
    })
    expect(parseStep('open main')).toMatchObject({ action: 'open', tab: 'main', target: null })
    expect(parseStep('open work https://b.com/x?a=1')).toMatchObject({
      action: 'open',
      tab: 'work',
      target: 'https://b.com/x?a=1',
    })
  })

  test('close all 与 close <标签>', () => {
    expect(parseStep('close all')).toEqual({ action: 'close', tab: null, target: 'all', said: 'close all' })
    expect(parseStep('close main')).toMatchObject({ action: 'close', tab: 'main', target: null })
  })

  test('tabs 不带标签', () => {
    expect(parseStep('tabs')).toEqual({ action: 'tabs', tab: null, target: null, said: 'tabs' })
  })

  test('main.click("#go") 解析成动作 + 标签 + 目标', () => {
    expect(parseStep('main.click("#go")')).toEqual({
      action: 'click',
      tab: 'main',
      target: '#go',
      said: 'main.click("#go")',
    })
  })

  test('调用链只取第一段的参数，嵌套括号不吃错', () => {
    expect(parseStep('main.goto("https://b.com")')).toMatchObject({ action: 'goto', target: 'https://b.com' })
    expect(parseStep('main.click(await tab.query("#go"))')).toMatchObject({ action: 'click' })
    expect(parseStep('main.fill("#q", "两个 词")')).toMatchObject({ action: 'fill', target: '#q' })
    expect(parseStep('main.run(fn)')).toMatchObject({ action: 'run', target: 'fn' })
  })

  test('认不出的原话留着，不是一片空白', () => {
    expect(parseStep('奇怪的一句话')).toEqual({ action: '', tab: null, target: null, said: '奇怪的一句话' })
  })
})

describe('browserCallModel：步骤', () => {
  const withEvents = (events: readonly unknown[], cells: readonly unknown[] = []): unknown => ({
    content: [{ type: 'text', text: 'ok' }],
    details: { statusEvents: events, cells },
  })

  test('details.statusEvents 与每个 cells[i].statusEvents 都收', () => {
    const model = browserCallModel(
      evalArgs(),
      withEvents(
        [{ op: 'browser', detail: 'open main https://a.com' }],
        [{ code: 'x', statusEvents: [{ op: 'browser', detail: 'main.click("#go")' }] }],
      ),
      false,
    )

    expect(model.steps.map((step) => step.action)).toEqual(['open', 'click'])
  })

  test('op 不是 browser 的不算步骤', () => {
    const model = browserCallModel(
      evalArgs(),
      withEvents([
        { op: 'computer', detail: 'click 10 10' },
        { op: 'browser', detail: 'open main https://a.com' },
      ]),
      false,
    )

    expect(model.steps).toHaveLength(1)
    expect(model.steps[0]?.action).toBe('open')
  })

  test('同一句 detail 出现两次只算一步', () => {
    const model = browserCallModel(
      evalArgs(),
      withEvents(
        [{ op: 'browser', detail: 'open main https://a.com' }],
        [{ statusEvents: [{ op: 'browser', detail: 'open main https://a.com' }] }],
      ),
      false,
    )

    expect(model.steps).toHaveLength(1)
  })

  test('没有状态事件时 steps 为空（卡片退回显示代码）', () => {
    const model = browserCallModel(evalArgs(), { content: [{ type: 'text', text: 'ok' }] }, false)

    expect(model.steps).toEqual([])
  })
})

describe('browserCallModel：代码与语言', () => {
  test('优先产出里真正跑过的 cells，多个用空行连接', () => {
    const model = browserCallModel(
      evalArgs({ code: '入参里的' }),
      { content: [], details: { cells: [{ code: '第一段' }, { code: '第二段' }] } },
      false,
    )

    expect(model.code).toBe('第一段\n\n第二段')
  })

  test('没有 cells 时退回 args.code', () => {
    expect(browserCallModel(evalArgs(), null, false).code).toBe('await browser.open({ url: "https://a.com" })')
  })

  test('语言只认 py，其余一律 js', () => {
    expect(browserCallModel(evalArgs({ language: 'py' }), null, false).language).toBe('py')
    expect(browserCallModel(evalArgs({ language: 'js' }), null, false).language).toBe('js')
    expect(browserCallModel(evalArgs({ language: 'python' }), null, false).language).toBe('js')
    expect(browserCallModel({}, null, false).language).toBe('js')
  })
})

describe('browserCallModel：截图', () => {
  test('details.images 转成 data URL', () => {
    const model = browserCallModel(
      evalArgs(),
      { content: [], details: { images: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] } },
      false,
    )

    expect(model.images).toEqual([{ src: 'data:image/png;base64,iVBORw0KGgo=', alt: '浏览器截图' }])
  })

  test('缺 mimeType 时按 png', () => {
    const model = browserCallModel(
      evalArgs(),
      { content: [], details: { images: [{ type: 'image', data: 'AA' }] } },
      false,
    )

    expect(model.images[0]?.src).toBe('data:image/png;base64,AA')
  })

  test('旧的 result.content 内联图仍然收，按 src 去重', () => {
    const model = browserCallModel(
      evalArgs(),
      {
        content: [{ type: 'image', data: 'SAME', mimeType: 'image/png' }],
        details: { images: [{ type: 'image', data: 'SAME', mimeType: 'image/png' }] },
      },
      false,
    )

    expect(model.images).toHaveLength(1)
  })

  test('没有 data 的图片条目不算数', () => {
    const model = browserCallModel(evalArgs(), { content: [], details: { images: [{ type: 'image' }] } }, false)

    expect(model.images).toEqual([])
  })
})

describe('browserCallModel：正文、错误与末次地址', () => {
  const textResult = (text: string): unknown => ({ content: [{ type: 'text', text }] })

  test('正文是 text 块拼接，超过 4000 字截断并加省略号', () => {
    expect(browserCallModel(evalArgs(), textResult('ok'), false).text).toBe('ok')

    const model = browserCallModel(evalArgs(), textResult('x'.repeat(4500)), false)

    expect(model.text).toHaveLength(4001)
    expect(model.text.endsWith('…')).toBe(true)
  })

  test('失败时 error 取正文第一段', () => {
    const model = browserCallModel(evalArgs(), textResult('选择器没找到\n\nat Object.click\nat …'), true)

    expect(model.error).toBe('选择器没找到')
  })

  test('失败却没有正文时给一句兜底', () => {
    expect(browserCallModel(evalArgs(), null, true).error).toBe('浏览器操作失败')
  })

  test('没失败就没有 error', () => {
    expect(browserCallModel(evalArgs(), textResult('选择器没找到'), false).error).toBeNull()
  })

  test('lastUrl 取最后一次带地址的 open', () => {
    const model = browserCallModel(
      evalArgs(),
      {
        content: [],
        details: {
          statusEvents: [
            { op: 'browser', detail: 'open main https://a.com' },
            { op: 'browser', detail: 'main.click("#go")' },
            { op: 'browser', detail: 'open work https://b.com' },
            { op: 'browser', detail: 'close all' },
          ],
        },
      },
      false,
    )

    expect(model.lastUrl).toBe('https://b.com')
  })

  test('有 open 没地址（空白标签）时 lastUrl 为空', () => {
    const model = browserCallModel(
      evalArgs(),
      { content: [], details: { statusEvents: [{ op: 'browser', detail: 'open main' }] } },
      false,
    )

    expect(model.lastUrl).toBeNull()
  })
})
