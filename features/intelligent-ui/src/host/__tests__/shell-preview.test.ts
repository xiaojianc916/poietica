import { describe, expect, test } from 'bun:test'
import { SHELL_JS } from '../shell'

/*
 * 预览清理真正跑一遍：外壳脚本在 iframe 的 window 里求值，只把闭包里的 inert() 挂到 window 上再调用。
 * shell.test 的字符串断言钉结构；这一条钉行为 —— 规则写在脚本里和规则真的生效是两回事。
 */

type Inert = (html: string) => DocumentFragment

/** happy-dom 的 iframe window 上有 eval，但 DOM 的 Window 类型没声明；测试里只在这一处需要求值外壳脚本 */
function runShellScriptIn(child: Window, code: string): void {
  const evaluator = child as unknown as { readonly eval?: (source: string) => unknown }
  if (evaluator.eval === undefined) throw new Error('iframe window 不能求值')
  evaluator.eval(code)
}

function inertOf(): Inert {
  const frame = document.createElement('iframe')
  frame.srcdoc = '<p>shell</p>'
  document.body.append(frame)
  const child = frame.contentWindow
  if (child === null) throw new Error('iframe 没有 contentWindow')
  /* 只改一处：把闭包里的清理函数暴露出来，其余外壳脚本原样执行 */
  const hooked = SHELL_JS.replace(
    "addEventListener('message',boot);",
    "window.__inert=inert;addEventListener('message',boot);",
  )
  runShellScriptIn(child, hooked)
  const inert = (child as unknown as { readonly __inert?: Inert }).__inert
  if (inert === undefined) throw new Error('外壳没有暴露 inert')
  return inert
}

function clean(html: string): string {
  const holder = document.createElement('div')
  holder.append(inertOf()(html))
  return holder.innerHTML
}

type Vendor = (html: string, message: Record<string, unknown>) => string

function vendorOf(): Vendor {
  const frame = document.createElement('iframe')
  frame.srcdoc = '<p>shell</p>'
  document.body.append(frame)
  const child = frame.contentWindow
  if (child === null) throw new Error('iframe 没有 contentWindow')
  const hooked = SHELL_JS.replace(
    "addEventListener('message',boot);",
    "window.__vendor=vendor;addEventListener('message',boot);",
  )
  runShellScriptIn(child, hooked)
  const vendor = (child as unknown as { readonly __vendor?: Vendor }).__vendor
  if (vendor === undefined) throw new Error('外壳没有暴露 vendor')
  return vendor
}

function outerOf(html: string, selector: string): string {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return holder.querySelector(selector)?.outerHTML ?? ''
}

const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'xlink:href'] as const

describe('预览清理行为', () => {
  test('P1 六类 URL 属性只留安全 scheme；# 锚点保留，javascript/vbscript/data:text/html/data:image/svg 删掉', () => {
    const html = [
      '<a id="ok-http" href="https://example.com/x">a</a>',
      '<a id="ok-mail" href="mailto:a@example.com">a</a>',
      '<a id="ok-anchor" href="#part">a</a>',
      '<img id="ok-img" src="data:image/png;base64,AAAA">',
      '<a id="bad-js" href="  javascript:alert(1)">a</a>',
      '<a id="bad-vbs" href="vbscript:msgbox(1)">a</a>',
      '<a id="bad-mixed" href="JaVaScRiPt:alert(1)">a</a>',
      '<img id="bad-data" src="data:text/html,<b>x</b>">',
      '<img id="bad-svg" src="data:image/svg+xml,x">',
      '<form id="bad-form" action="javascript:x"><button formaction="javascript:x">b</button></form>',
      '<video id="bad-poster" poster="javascript:x"></video>',
      '<svg><a id="bad-xlink" xlink:href="javascript:x"><text>t</text></a></svg>',
    ].join('')
    const body = clean(html)
    expect(outerOf(body, '#ok-http')).toContain('href="https://example.com/x"')
    expect(outerOf(body, '#ok-mail')).toContain('href="mailto:a@example.com"')
    expect(outerOf(body, '#ok-anchor')).toContain('href="#part"')
    expect(outerOf(body, '#ok-img')).toContain('src="data:image/png;base64,AAAA"')
    for (const id of ['bad-js', 'bad-vbs', 'bad-mixed', 'bad-data', 'bad-svg']) {
      const tag = outerOf(body, `#${id}`)
      for (const name of URL_ATTRS) expect(tag).not.toMatch(new RegExp(`\\s${name.replace(':', '\\:')}=`, 'i'))
    }
    expect(body).not.toMatch(/formaction=/i)
    expect(body).not.toMatch(/poster=/i)
    expect(body).not.toMatch(/xlink:href=/i)
  })

  test('P2 style 属性与 <style> 去掉 @import 和非图片 data: 的 url()；图片 data: 保留', () => {
    const body = clean(
      [
        '<style>@import "https://evil.example/x.css";.a{background:url(https://evil.example/x.png)}.b{background:url(data:image/png;base64,AAAA)}.c{color:red}</style>',
        '<div id="s" style="background:url(javascript:alert(1));border-image:url(data:image/svg+xml,x);color:blue">d</div>',
      ].join(''),
    )
    expect(body).not.toContain('@import')
    expect(body).not.toContain('evil.example/x.png')
    expect(body).not.toContain('javascript:')
    expect(body).not.toContain('data:image/svg')
    expect(body).toContain('url(data:image/png;base64,AAAA)')
    expect(body).toContain('color:red')
    expect(body).toContain('color:blue')
  })

  test('P3 随包库替换与导出判定同语义：只认 <script src>，注释/正文不换；引号与空白容忍', () => {
    const url = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js'
    const local = 'poietica-asset://intelligent-ui/vendor/d3-7.9.0.min.js'
    const message = { libraries: {}, standalone: false, html: '' }
    const vendor = vendorOf()
    expect(
      vendor(`<script src="${url}" integrity="sha384-x" crossorigin="anonymous" type="module"></script>`, message),
    ).toBe(`<script src="${local}"></script>`)
    expect(vendor(`<SCRIPT  SRC = '${url}'></SCRIPT>`, message)).toBe(`<SCRIPT  SRC = "${local}"></SCRIPT>`)
    expect(vendor(`<script src=${url}></script>`, message)).toBe(`<script src="${local}"></script>`)
    const text = `<!-- <script src="${url}"></script> --><script>var sample='<script src="${url}"></script>'</script><p>${url}</p>`
    expect(vendor(text, message)).toBe(text)
  })
})
