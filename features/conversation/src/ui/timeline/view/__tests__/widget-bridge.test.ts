import { describe, expect, test } from 'bun:test'
import { WIDGET_TOKEN_NAMES } from '../../../../contract'
import {
  externalUrlOf,
  parseWidgetMessage,
  WIDGET_TEXT_MAX,
  WIDGET_TOKEN_SOURCES,
  widgetAddressOf,
  widgetArgsOf,
  widgetFailureOf,
  widgetTokenCss,
} from '../widget-bridge'

describe('组件小桥（审查 R-18）', () => {
  test('B1 交给组件的变量名与工具描述里写给模型的那张表一字不差', () => {
    expect(Object.keys(WIDGET_TOKEN_SOURCES)).toEqual([...WIDGET_TOKEN_NAMES])
  })

  test('B2 令牌 → :root；空值跳过，能拆开样式表的值整格丢掉', () => {
    const values: Record<string, string> = {
      '--cp-timeline-body-ink': ' oklch(0.2 0.01 90) ',
      '--cp-ink-muted': '',
      '--ui-font-sans': 'Inter, "Segoe UI", sans-serif',
      '--ui-card': 'red;}</style><script>',
    }
    const css = widgetTokenCss((token) => values[token] ?? '')
    expect(css.startsWith(':root{')).toBe(true)
    expect(css).toContain('--color-text:oklch(0.2 0.01 90)')
    expect(css).toContain('--font-sans:Inter, "Segoe UI", sans-serif')
    expect(css).not.toContain('--color-text-muted')
    expect(css).not.toContain('--color-surface-raised')
    expect(css).not.toContain('<')
  })

  test('B3 参数：恰好一种来源；高度夹在 80–2000；标题缺省为「组件」', () => {
    expect(widgetArgsOf({ title: 'A', html: '<p>x</p>' })).toEqual({ title: 'A', html: '<p>x</p>', bare: false })
    expect(widgetArgsOf({ url: 'http://localhost:5173/', height: 12, bare: true })).toEqual({
      title: '组件',
      url: 'http://localhost:5173/',
      height: 80,
      bare: true,
    })
    expect(widgetArgsOf({ html: 'x', height: 99999 })?.height).toBe(2000)
    expect(widgetArgsOf({ html: 'x', url: 'http://localhost/' })).toBeNull()
    expect(widgetArgsOf({ title: 'A' })).toBeNull()
    expect(widgetArgsOf('{"html":')).toBeNull()
    expect(widgetArgsOf(null)).toBeNull()
  })

  test('B4 外壳消息：只认六种；字段不对当没收到；发送的字截到上限', () => {
    expect(parseWidgetMessage({ type: 'poietica:ready' })).toEqual({ type: 'ready' })
    expect(parseWidgetMessage({ type: 'poietica:height', height: 120.2 })).toEqual({ type: 'height', height: 121 })
    expect(parseWidgetMessage({ type: 'poietica:height', height: -1 })).toBeNull()
    expect(parseWidgetMessage({ type: 'poietica:height', height: Number.NaN })).toBeNull()
    expect(parseWidgetMessage({ type: 'poietica:send', text: '  用方案 B  ' })).toEqual({
      type: 'send',
      text: '用方案 B',
    })
    expect(parseWidgetMessage({ type: 'poietica:send', text: '   ' })).toBeNull()
    expect(parseWidgetMessage({ type: 'poietica:draft', text: 'x'.repeat(WIDGET_TEXT_MAX + 10) })).toEqual({
      type: 'draft',
      text: 'x'.repeat(WIDGET_TEXT_MAX),
    })
    expect(parseWidgetMessage({ type: 'poietica:open', url: 'https://a.dev' })).toEqual({
      type: 'open',
      url: 'https://a.dev',
    })
    expect(parseWidgetMessage({ type: 'poietica:error', message: 'boom' })).toEqual({ type: 'error', message: 'boom' })
    expect(parseWidgetMessage({ type: 'poietica:render', html: 'x' })).toBeNull()
    expect(parseWidgetMessage('poietica:ready')).toBeNull()
    expect(parseWidgetMessage(null)).toBeNull()
  })

  test('B5 外链只放 http(s) 与 mailto', () => {
    expect(externalUrlOf('https://example.com/a')).toBe('https://example.com/a')
    expect(externalUrlOf('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(externalUrlOf('javascript:alert(1)')).toBeNull()
    expect(externalUrlOf('file:///C:/Windows')).toBeNull()
    expect(externalUrlOf('poietica-asset://attachment/x')).toBeNull()
    expect(externalUrlOf('/relative')).toBeNull()
  })

  test('B6 失败那一句与地址条', () => {
    expect(widgetFailureOf('打不开')).toBe('打不开')
    expect(widgetFailureOf({ content: [{ type: 'text', text: 'HTTP 404' }] })).toBe('HTTP 404')
    expect(widgetFailureOf({ message: 'boom' })).toBe('boom')
    expect(widgetFailureOf(null)).toBe('组件没能显示')
    expect(widgetAddressOf('http://localhost:5173/')).toBe('localhost:5173')
    expect(widgetAddressOf('http://localhost:5173/__preview?v=2')).toBe('localhost:5173/__preview?v=2')
  })
})
