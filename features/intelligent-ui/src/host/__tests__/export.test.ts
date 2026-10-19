import { describe, expect, test } from 'bun:test'
import { captureRectOf } from '../capture'
import { exportFileNameOf, STANDALONE_CSP, type StandaloneInput, standaloneHtml } from '../export'
import { INTELLIGENT_UI_CSP, SHELL_JS } from '../shell'
import { vendorText } from '../vendor'

/*
 * 导出与截图的纯函数。导出的文件在真机（Chromium）里打开过：随包库经 blob: 加载、integrity 被去掉、
 * <meta> 里的 CSP 在 document.open 之后仍然拦得住 fetch、状态与调整值都还原 —— 见方案页的实测记录。
 */

const input: StandaloneInput = {
  title: '方案 <对比> & "定稿"',
  html: '<p>x</p><script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script>"</script>"</script>',
  bare: false,
  wide: true,
  css: ':root{--color-text:#111}',
  theme: 'dark',
  state: { model: '{"picked":"B"}', view: null, tweaks: '{"g":{"r":7}}' },
}

function dataOf(html: string): Record<string, unknown> {
  const match = /<script type="application\/json" id="poietica-export">([\s\S]*?)<\/script>/.exec(html)
  if (match === null) throw new Error('没有内嵌数据')
  return JSON.parse(match[1] ?? '') as Record<string, unknown>
}

describe('导出 HTML', () => {
  test('E1 CSP 走 <meta>，与外壳同一张表、只少了 meta 不认的 sandbox', () => {
    expect(STANDALONE_CSP).not.toContain('sandbox')
    expect(INTELLIGENT_UI_CSP.startsWith(STANDALONE_CSP)).toBe(true)
    const html = standaloneHtml(input)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${STANDALONE_CSP}">`)
    expect(html).toContain('<title>方案 &lt;对比&gt; &amp; &quot;定稿&quot;</title>')
  })

  test('E2 正文：同一份外壳脚本 + 引导；内嵌数据拆不开 <script>，用到的库才内嵌', () => {
    const html = standaloneHtml(input)
    expect(html).toContain(SHELL_JS)
    /* 外壳、引导、数据三段；界面里的 </script> 被转义，数一数就知道没被拆开 */
    expect(html.match(/<\/script>/g)).toHaveLength(3)
    const data = dataOf(html)
    expect(data).toMatchObject({ title: input.title, html: input.html, bare: false, wide: true, theme: 'dark' })
    expect(data.state).toEqual(input.state)
    expect(Object.keys(data.libraries as object)).toEqual(['d3-7.9.0.min.js'])
    expect((data.libraries as Record<string, string>)['d3-7.9.0.min.js']).toBe(vendorText('d3-7.9.0.min.js') ?? '')
    const plain = dataOf(standaloneHtml({ ...input, html: '<p>没有库</p>' }))
    expect(plain.libraries).toEqual({})
  })

  test('E3 引导：load 之后自己给自己发 render（standalone），open 只认手势与 http(s)/mailto', () => {
    const html = standaloneHtml(input)
    expect(html).toContain("type:'poietica:render',standalone:true")
    expect(html).toContain("addEventListener('load',start,{once:true})")
    expect(html).toContain("d.type==='open'&&d.gesture===true")
    expect(html).toContain("'noopener,noreferrer'")
  })

  test('E4 默认文件名：去掉文件系统不认的字符；空了用「界面」；Windows 保留名垫下划线', () => {
    expect(exportFileNameOf('方案 A/B: 对比?')).toBe('方案 A B 对比.html')
    expect(exportFileNameOf('  ...  ')).toBe('界面.html')
    expect(exportFileNameOf('a\u0000b\u001fc')).toBe('a b c.html')
    expect(exportFileNameOf('CON')).toBe('_CON.html')
    expect(exportFileNameOf('结尾的点.')).toBe('结尾的点.html')
    expect(exportFileNameOf('x'.repeat(200))).toBe(`${'x'.repeat(80)}.html`)
  })

  test('E4b 文件名去掉 bidi 控制符与孤立代理项；合法代理对（emoji）保留', () => {
    const bidi = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069'
    expect(exportFileNameOf(`a${bidi}b`)).toBe('a b.html')
    /* 一个落单的高代理项 + 正常文字：不能原样落进文件名 */
    expect(exportFileNameOf(`a\ud83db`)).toBe('a b.html')
    expect(exportFileNameOf(`a\udc00b`)).toBe('a b.html')
    expect(exportFileNameOf('方案 \u{1f600}')).toBe('方案 \u{1f600}.html')
  })
})

describe('复制为图片', () => {
  test('C1 CSS 像素 × 页面缩放 = DIP，向外取整；超出内容区的裁掉', () => {
    const content = { width: 1200, height: 800 }
    expect(captureRectOf({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, 1, content)).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 51,
    })
    expect(captureRectOf({ x: 100, y: 100, width: 200, height: 100 }, 1.25, content)).toEqual({
      x: 125,
      y: 125,
      width: 250,
      height: 125,
    })
    expect(captureRectOf({ x: -50, y: 700, width: 300, height: 400 }, 1, content)).toEqual({
      x: 0,
      y: 700,
      width: 250,
      height: 100,
    })
  })

  test('C3 内容区宽高不是有限正数：null（窗口没布局或量坏了不硬截）', () => {
    const rect = { x: 10, y: 10, width: 100, height: 50 }
    expect(captureRectOf(rect, 1, { width: 0, height: 800 })).toBeNull()
    expect(captureRectOf(rect, 1, { width: 1200, height: 0 })).toBeNull()
    expect(captureRectOf(rect, 1, { width: Number.NaN, height: 800 })).toBeNull()
    expect(captureRectOf(rect, 1, { width: 1200, height: Number.POSITIVE_INFINITY })).toBeNull()
    expect(captureRectOf(rect, 1, { width: -1, height: 800 })).toBeNull()
  })

  test('C2 整块在窗口外：null；缩放值不对按 1', () => {
    const content = { width: 1200, height: 800 }
    expect(captureRectOf({ x: 0, y: 900, width: 100, height: 100 }, 1, content)).toBeNull()
    expect(captureRectOf({ x: 0, y: -200, width: 100, height: 100 }, 1, content)).toBeNull()
    expect(captureRectOf({ x: 1, y: 2, width: 3, height: 4 }, Number.NaN, content)).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    })
  })
})
