import { describe, expect, test } from 'bun:test'
import { WIDGET_LIBRARY_ORIGINS, WIDGET_SHELL_FILE, WIDGET_SHELL_URL } from '../../contract'
import { createWidgetShellHandler, WIDGET_CSP, WIDGET_SHELL_HTML } from '../widget-shell'

/*
 * 对话内组件的外壳（审查 R-18）。脚本在 iframe 里跑的那一半由 Windows 真机验收（R-18 页第 6 节）；
 * 这里钉住协议处理器与 CSP —— 安全边界全在这张表上。
 */

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

describe('组件外壳（审查 R-18）', () => {
  test('S1 只认外壳这一个文件，回 html 与 CSP 响应头', async () => {
    const handler = createWidgetShellHandler()
    const request = new Request(WIDGET_SHELL_URL)
    const ok = await handler([WIDGET_SHELL_FILE], request)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(ok.headers.get('Content-Security-Policy')).toBe(WIDGET_CSP)
    expect(await ok.text()).toBe(WIDGET_SHELL_HTML)
    expect((await handler([], request)).status).toBe(404)
    expect((await handler(['other.html'], request)).status).toBe(404)
    expect((await handler([WIDGET_SHELL_FILE, 'x'], request)).status).toBe(404)
  })

  test('S2 CSP：默认全关；脚本、样式、字体只多放公共 CDN；图片只认 data/blob；不能嵌套、不能提交表单', () => {
    const csp = directives(WIDGET_CSP)
    expect(csp.get('default-src')).toEqual(["'none'"])
    for (const name of ['script-src', 'style-src', 'font-src', 'connect-src']) {
      for (const origin of WIDGET_LIBRARY_ORIGINS) expect(csp.get(name)).toContain(origin)
    }
    expect(csp.get('connect-src')).toEqual([...WIDGET_LIBRARY_ORIGINS])
    expect(csp.get('img-src')).toEqual(['data:', 'blob:'])
    expect(csp.get('frame-src')).toEqual(["'none'"])
    expect(csp.get('form-action')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'none'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    // 外壳被直接打开（不在 iframe 里）时也是不透明源
    expect(csp.get('sandbox')).toEqual(['allow-scripts', 'allow-forms'])
    expect(WIDGET_CSP).not.toContain('allow-same-origin')
    expect(WIDGET_CSP).not.toContain('https:;')
  })

  test('S3 外壳只听父窗口，ready 之后等 render；小桥在组件文档里重新装', () => {
    expect(WIDGET_SHELL_HTML).toContain('e.source!==parent')
    expect(WIDGET_SHELL_HTML).toContain('poietica:ready')
    expect(WIDGET_SHELL_HTML).toContain('poietica:render')
    expect(WIDGET_SHELL_HTML).toContain('document.open()')
    expect(WIDGET_SHELL_HTML).toContain('poietica:height')
    // 外壳本身只有一段脚本，不能在 </script> 处被拆开
    expect(WIDGET_SHELL_HTML.match(/<\/script>/g)).toHaveLength(1)
  })
})
