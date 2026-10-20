import { describe, expect, test } from 'bun:test'
import { INTELLIGENT_UI_TOKEN_NAMES } from '../../contract'
import {
  coerceTweak,
  externalUrlOf,
  failureOf,
  parseFrameMessage,
  TOKEN_SOURCES,
  tokenCss,
  VIEW_HEIGHT_MAX,
  VIEW_TEXT_MAX,
  viewArgsOf,
  viewDraftOf,
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

  test('B3 参数：html 必须非空；bare / wide 只认 true；标题缺省为「界面」、截到 80 字；url 来源不再认', () => {
    expect(viewArgsOf({ title: 'A', html: '<p>x</p>' })).toEqual({
      title: 'A',
      html: '<p>x</p>',
      bare: false,
      wide: false,
    })
    expect(viewArgsOf({ html: 'x', bare: true, wide: true })).toEqual({
      title: '界面',
      html: 'x',
      bare: true,
      wide: true,
    })
    expect(viewArgsOf({ html: 'x', wide: 'yes' })?.wide).toBe(false)
    expect(viewArgsOf({ title: 'x'.repeat(200), html: 'x' })?.title).toHaveLength(80)
    expect(viewArgsOf({ url: 'http://localhost:5173/' })).toBeNull()
    expect(viewArgsOf({ title: 'A', html: '   ' })).toBeNull()
    expect(viewArgsOf({ title: 'A' })).toBeNull()
    expect(viewArgsOf('{"html":')).toBeNull()
    expect(viewArgsOf(null)).toBeNull()
    expect(viewTitleOf({ title: '方案' })).toBe('方案')
    expect(viewTitleOf('{"title":')).toBe('界面')
  })

  test('B3b 参数还在流：到此为止的那一份，html 可以是半截或还没有', () => {
    expect(viewDraftOf({ title: '仪表盘', wide: true })).toEqual({ title: '仪表盘', html: '', bare: false, wide: true })
    expect(viewDraftOf({ title: '仪表盘', html: '<style>a{}</style><div cla' }).html).toBe('<style>a{}</style><div cla')
    expect(viewDraftOf(undefined)).toEqual({ title: '界面', html: '', bare: false, wide: false })
  })

  test('B4 端口消息：只认八种；字段不对当没收到；手势只认 true；字截到上限', () => {
    expect(parseFrameMessage({ type: 'height', height: 120.2 })).toEqual({ type: 'height', height: 121 })
    expect(parseFrameMessage({ type: 'escape', key: 'x' })).toEqual({ type: 'escape' })
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
    expect(parseFrameMessage({ type: 'state', model: '{"a":1}', view: null, tweaks: '{}' })).toEqual({
      type: 'state',
      model: '{"a":1}',
      view: null,
      tweaks: '{}',
    })
    /* 旧外壳不带 tweaks：当 null */
    expect(parseFrameMessage({ type: 'state', model: null, view: null })).toEqual({
      type: 'state',
      model: null,
      view: null,
      tweaks: null,
    })
    expect(parseFrameMessage({ type: 'state', model: null, view: null, tweaks: {} })).toBeNull()
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

  test('B6 失败那一句', () => {
    expect(failureOf('打不开')).toBe('打不开')
    expect(failureOf({ content: [{ type: 'text', text: 'HTTP 404' }] })).toBe('HTTP 404')
    expect(failureOf({ message: 'boom' })).toBe('boom')
    expect(failureOf(null)).toBe('界面没能显示')
  })

  const range = { key: 'r', label: '圆角', type: 'range', min: 0, max: 24, step: 1, unit: 'px', value: 8 }
  const select = {
    key: 'd',
    label: '密度',
    type: 'select',
    options: [
      { value: 'compact', label: '紧凑' },
      { value: 'cozy', label: '宽松' },
    ],
    value: 'cozy',
  }

  test('B7 调整控件登记：四种控件逐项校验，当前值收进范围、缺了用默认值', () => {
    const message = parseFrameMessage({
      type: 'tweak',
      op: 'register',
      id: 1,
      label: '卡片',
      controls: [
        range,
        { key: 'c', label: '主色', type: 'color', value: '#3b82f6' },
        { key: 't', label: '阴影', type: 'toggle', value: true },
        select,
      ],
      values: { r: 99, c: '#FF0000', t: 'no', d: 'compact' },
    })
    expect(message).toEqual({
      type: 'tweak',
      op: 'register',
      group: {
        id: 1,
        label: '卡片',
        controls: [
          { type: 'range', key: 'r', label: '圆角', min: 0, max: 24, step: 1, unit: 'px', value: 8 },
          { type: 'color', key: 'c', label: '主色', value: '#3b82f6' },
          { type: 'toggle', key: 't', label: '阴影', value: true },
          {
            type: 'select',
            key: 'd',
            label: '密度',
            options: [
              { value: 'compact', label: '紧凑' },
              { value: 'cozy', label: '宽松' },
            ],
            value: 'cozy',
          },
        ],
        values: { r: 24, c: '#ff0000', t: true, d: 'compact' },
      },
    })
    expect(parseFrameMessage({ type: 'tweak', op: 'dispose', id: 1 })).toEqual({ type: 'tweak', op: 'dispose', id: 1 })
  })

  test('B8 调整控件：坏的一项让整组作废（外壳和界面同一个全局，交来的东西不全信）', () => {
    const group = (controls: unknown[], extra: Record<string, unknown> = {}) =>
      parseFrameMessage({ type: 'tweak', op: 'register', id: 2, label: 'g', controls, values: {}, ...extra })
    expect(group([range])).not.toBeNull()
    expect(group([])).toBeNull()
    expect(group([{ ...range, min: 5, max: 5 }])).toBeNull()
    expect(group([{ ...range, key: 'has space' }])).toBeNull()
    expect(group([range, range])).toBeNull()
    expect(group([{ ...range, type: 'text' }])).toBeNull()
    expect(group([{ key: 'c', label: 'c', type: 'color', value: 'red' }])).toBeNull()
    expect(group([{ ...select, value: 'other' }])).toBeNull()
    expect(group(Array.from({ length: 13 }, (_, i) => ({ ...range, key: `k${i}` })))).toBeNull()
    expect(group([range], { id: 0 })).toBeNull()
    expect(group([range], { label: '' })).toBeNull()
    expect(parseFrameMessage({ type: 'tweak', op: 'other', id: 1 })).toBeNull()
  })

  test('B9 值收进控件的范围；收不进是 undefined', () => {
    const control = { type: 'range', key: 'r', label: 'r', min: 0, max: 10, step: 1, unit: '', value: 5 } as const
    expect(coerceTweak(control, -3)).toBe(0)
    expect(coerceTweak(control, 99)).toBe(10)
    expect(coerceTweak(control, '3')).toBeUndefined()
    expect(coerceTweak(control, true)).toBeUndefined()
    expect(coerceTweak(control, Number.NaN)).toBeUndefined()
    expect(coerceTweak(control, Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(coerceTweak({ type: 'color', key: 'c', label: 'c', value: '#000000' }, '#ABCDEF')).toBe('#abcdef')
    expect(coerceTweak({ type: 'toggle', key: 't', label: 't', value: false }, 1)).toBeUndefined()
  })
})
