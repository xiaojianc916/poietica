import { describe, expect, test } from 'bun:test'
import { INTELLIGENT_UI_TOKEN_NAMES } from '../../contract'
import {
  addressOf,
  externalUrlOf,
  failureOf,
  parseFrameMessage,
  TOKEN_SOURCES,
  tokenCss,
  VIEW_HEIGHT_MAX,
  VIEW_TEXT_MAX,
  viewArgsOf,
  viewTitleOf,
} from '../bridge'

describe('智能界面的纯逻辑', () => {
  test('B1 交给界面的变量名与指南里写给模型的那张表一字不差', () => {
    expect(Object.keys(TOKEN_SOURCES)).toEqual([...INTELLIGENT_UI_TOKEN_NAMES])
  })

  test('B2 令牌 → :root；空值跳过，能拆开样式表的值整格丢掉', () => {
    const values: Record<string, string> = {
      '--cp-timeline-body-ink': ' oklch(0.2 0.01 90) ',
      '--cp-ink-muted': '',
      '--ui-font-sans': 'Inter, "Segoe UI", sans-serif',
      '--ui-card': 'red;}</style><script>',
    }
    const css = tokenCss((token) => values[token] ?? '')
    expect(css.startsWith(':root{')).toBe(true)
    expect(css).toContain('--color-text:oklch(0.2 0.01 90)')
    expect(css).toContain('--font-sans:Inter, "Segoe UI", sans-serif')
    expect(css).not.toContain('--color-text-muted')
    expect(css).not.toContain('--color-surface-raised')
    expect(css).not.toContain('<')
  })

  test('B3 参数：恰好一种来源；高度夹在 80–2000；标题缺省为「界面」、截到 80 字', () => {
    expect(viewArgsOf({ title: 'A', html: '<p>x</p>' })).toEqual({ title: 'A', html: '<p>x</p>', bare: false })
    expect(viewArgsOf({ url: 'http://localhost:5173/', height: 12, bare: true })).toEqual({
      title: '界面',
      url: 'http://localhost:5173/',
      height: 80,
      bare: true,
    })
    expect(viewArgsOf({ html: 'x', height: 99999 })?.height).toBe(2000)
    expect(viewArgsOf({ title: 'x'.repeat(200), html: 'x' })?.title).toHaveLength(80)
    expect(viewArgsOf({ html: 'x', url: 'http://localhost/' })).toBeNull()
    expect(viewArgsOf({ title: 'A' })).toBeNull()
    expect(viewArgsOf('{"html":')).toBeNull()
    expect(viewArgsOf(null)).toBeNull()
    expect(viewTitleOf({ title: '方案' })).toBe('方案')
    expect(viewTitleOf('{"title":')).toBe('界面')
  })

  test('B4 端口消息：只认六种；字段不对当没收到；手势只认 true；字截到上限', () => {
    expect(parseFrameMessage({ type: 'height', height: 120.2 })).toEqual({ type: 'height', height: 121 })
    expect(parseFrameMessage({ type: 'height', height: 1e9 })).toEqual({ type: 'height', height: VIEW_HEIGHT_MAX })
    expect(parseFrameMessage({ type: 'height', height: -1 })).toBeNull()
    expect(parseFrameMessage({ type: 'height', height: Number.NaN })).toBeNull()
    expect(parseFrameMessage({ type: 'send', text: '  用方案 B  ', gesture: true })).toEqual({
      type: 'send',
      text: '用方案 B',
      gesture: true,
    })
    expect(parseFrameMessage({ type: 'send', text: 'x', gesture: 'yes' })).toEqual({
      type: 'send',
      text: 'x',
      gesture: false,
    })
    expect(parseFrameMessage({ type: 'send', text: '   ' })).toBeNull()
    expect(parseFrameMessage({ type: 'draft', text: 'x'.repeat(VIEW_TEXT_MAX + 10) })).toEqual({
      type: 'draft',
      text: 'x'.repeat(VIEW_TEXT_MAX),
      gesture: false,
    })
    expect(parseFrameMessage({ type: 'open', url: 'https://a.dev', gesture: true })).toEqual({
      type: 'open',
      url: 'https://a.dev',
      gesture: true,
    })
    expect(parseFrameMessage({ type: 'state', model: '{"a":1}', view: null })).toEqual({
      type: 'state',
      model: '{"a":1}',
      view: null,
    })
    expect(parseFrameMessage({ type: 'state', model: { a: 1 }, view: null })).toBeNull()
    expect(parseFrameMessage({ type: 'error', message: 'x'.repeat(900) })).toEqual({
      type: 'error',
      message: 'x'.repeat(500),
    })
    /* 旧版 window 级消息的名字一概不认 */
    expect(parseFrameMessage({ type: 'poietica:send', text: 'x' })).toBeNull()
    expect(parseFrameMessage({ type: 'render', html: 'x' })).toBeNull()
    expect(parseFrameMessage('send')).toBeNull()
    expect(parseFrameMessage(null)).toBeNull()
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
    expect(failureOf('打不开')).toBe('打不开')
    expect(failureOf({ content: [{ type: 'text', text: 'HTTP 404' }] })).toBe('HTTP 404')
    expect(failureOf({ message: 'boom' })).toBe('boom')
    expect(failureOf(null)).toBe('界面没能显示')
    expect(addressOf('http://localhost:5173/')).toBe('localhost:5173')
    expect(addressOf('http://localhost:5173/__preview?v=2')).toBe('localhost:5173/__preview?v=2')
  })
})
