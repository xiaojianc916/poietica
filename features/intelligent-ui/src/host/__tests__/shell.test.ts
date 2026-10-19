import { describe, expect, test } from 'bun:test'
import {
  INTELLIGENT_UI_CLASS_NAMES,
  INTELLIGENT_UI_LIBRARY_ORIGINS,
  INTELLIGENT_UI_SHELL_FILE,
  INTELLIGENT_UI_SHELL_URL,
} from '../../contract'
import { BASE_CSS, createShellHandler, INTELLIGENT_UI_CSP, INTELLIGENT_UI_SHELL_HTML } from '../shell'

/*
 * 智能界面的外壳。脚本在 iframe 里跑的那一半由真机（Chromium）验收：私有端口在 document.open 之后仍在、
 * window 上伪造的消息到不了端口、没有手势时 send 带 gesture:false、改了原型小桥照样工作 —— 见方案页的实测记录。
 * 这里钉住协议处理器、CSP（安全边界全在这张表上）与外壳脚本的几处结构。
 */

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

describe('智能界面外壳', () => {
  test('S1 只认外壳这一个文件，回 html 与 CSP 响应头', async () => {
    const handler = createShellHandler()
    const request = new Request(INTELLIGENT_UI_SHELL_URL)
    expect(INTELLIGENT_UI_SHELL_URL).toBe('poietica-asset://intelligent-ui/shell.html')
    const ok = await handler([INTELLIGENT_UI_SHELL_FILE], request)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(ok.headers.get('Content-Security-Policy')).toBe(INTELLIGENT_UI_CSP)
    expect(ok.headers.get('Cache-Control')).toBe('no-cache')
    expect(await ok.text()).toBe(INTELLIGENT_UI_SHELL_HTML)
    expect((await handler([], request)).status).toBe(404)
    expect((await handler(['other.html'], request)).status).toBe(404)
    expect((await handler([INTELLIGENT_UI_SHELL_FILE, 'x'], request)).status).toBe(404)
  })

  test('S2 CSP：默认全关；脚本、样式、字体只多放公共 CDN；图片只认 data/blob；不能嵌套、不能提交表单', () => {
    const csp = directives(INTELLIGENT_UI_CSP)
    expect(csp.get('default-src')).toEqual(["'none'"])
    for (const name of ['script-src', 'style-src', 'font-src', 'connect-src']) {
      for (const origin of INTELLIGENT_UI_LIBRARY_ORIGINS) expect(csp.get(name)).toContain(origin)
    }
    expect(csp.get('connect-src')).toEqual([...INTELLIGENT_UI_LIBRARY_ORIGINS])
    expect(csp.get('img-src')).toEqual(['data:', 'blob:'])
    expect(csp.get('frame-src')).toEqual(["'none'"])
    expect(csp.get('form-action')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'none'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    // 外壳被直接打开（不在 iframe 里）时也是不透明源
    expect(csp.get('sandbox')).toEqual(['allow-scripts', 'allow-forms'])
    expect(INTELLIGENT_UI_CSP).not.toContain('allow-same-origin')
    expect(INTELLIGENT_UI_CSP).not.toContain('https:;')
  })

  test('S3 外壳只收父窗口的一次 render 与端口；之后只走端口，不再往 window 上发话', () => {
    const html = INTELLIGENT_UI_SHELL_HTML
    expect(html).toContain('e.source!==parent')
    expect(html).toContain("d.type!=='poietica:render'||!port")
    expect(html).toContain("removeEventListener('message',boot)")
    expect(html).toContain('document.open()')
    /* 小桥装在 document.open 之后、写入界面文档之前 */
    expect(html.indexOf('var settle=install(port,d)')).toBeGreaterThan(html.indexOf('document.open()'))
    expect(html.indexOf('document.write(compose(d))')).toBeGreaterThan(html.indexOf('var settle=install(port,d)'))
    /* 旧版的握手与 window 级往来都不在了 */
    expect(html).not.toContain('poietica:ready')
    expect(html).not.toContain('parent.postMessage')
    expect(html).not.toContain('poietica:height')
    // 外壳本身只有一段脚本，不能在 </script> 处被拆开
    expect(html.match(/<\/script>/g)).toHaveLength(1)
  })

  test('S4 小桥：先绑死内建函数；手势只认 isTrusted、一次一换；状态有上限', () => {
    const html = INTELLIGENT_UI_SHELL_HTML
    expect(html).toContain('var post=port.postMessage.bind(port)')
    expect(html).toContain('var now=Date.now.bind(Date)')
    expect(html).toContain('if(e.isTrusted){credit=true')
    expect(html).toContain('if(g)credit=false')
    expect(html).toContain("define(window,'poietica',{value:freeze(api)})")
    expect(html).toContain('MODEL_MAX=4096')
    expect(html).toContain('VIEW_MAX=12288')
  })

  test('S6 CSP：随包库只多放外壳自己这个 host；connect-src 不放它', () => {
    const csp = directives(INTELLIGENT_UI_CSP)
    expect(csp.get('script-src')).toContain('poietica-asset://intelligent-ui')
    expect(csp.get('connect-src')).not.toContain('poietica-asset://intelligent-ui')
    expect(csp.get('style-src')).not.toContain('poietica-asset://intelligent-ui')
  })

  test('S7 预览：不装小桥、body 带 inert，去掉会执行与会导航的东西；render 才换成真界面', () => {
    const html = INTELLIGENT_UI_SHELL_HTML
    expect(html).toContain('if(d.preview)preview(port,d);else live(port,d)')
    expect(html).toContain('<body inert></body>')
    for (const tag of ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'template']) expect(html).toContain(tag)
    expect(html).toContain("name.slice(0,2)==='on'")
    expect(html).toContain("if(d.type==='render'){ro.disconnect();port.onmessage=null;live(port,d)}")
    /* 预览期间端口上只接 preview / theme / render，小桥（window.poietica）不存在 */
    expect(html.indexOf('function preview(')).toBeLessThan(html.indexOf('function install('))
  })

  test('S7b 预览清理 URL：非安全 scheme 的属性删掉；# 锚点与 http(s)/mailto/data 图片保留', () => {
    const html = INTELLIGENT_UI_SHELL_HTML
    expect(html).toContain("var URL_ATTRS={href:1,src:1,action:1,formaction:1,poster:1,'xlink:href':1}")
    expect(html).toContain('function safeUrl(v)')
    expect(html).toContain("t.charAt(0)==='#'")
    expect(html).toContain('t=trimUrl(v).toLowerCase()')
    expect(html).toContain('/^(?:https?:|mailto:|data:image\\/(?:png|jpeg|gif|webp)(?:[;,]|$))/')
    expect(html).not.toContain('^\\\\s*javascript:')
  })

  test('S7c 预览清理样式：@import 与 url(...) 里非图片 data: 的引用去掉；超长未闭合输入不会炸正则', () => {
    const html = INTELLIGENT_UI_SHELL_HTML
    expect(html).toContain('function withoutImports(css)')
    expect(html).toContain("low.indexOf('@import',pos)")
    expect(html).toContain('function cleanCss(css)')
    expect(html).toContain("low.indexOf('url(',pos)")
    expect(html).toContain('function cssUrl(v)')
    expect(html).toContain('if(cssUrl(raw))out+=text.slice(next,close+1)')
    expect(html).toContain('n.textContent=cleanCss(n.textContent)')
    expect(html).toContain("if(name==='style'){var css=cleanCss(a.value)")
  })

  test('S8 随包库：只换精确地址，被换的那个 <script> 去掉 integrity / crossorigin / type', () => {
    const html = INTELLIGENT_UI_SHELL_HTML
    expect(html).toContain('https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js')
    expect(html).toContain('poietica-asset://intelligent-ui/vendor/d3-7.9.0.min.js')
    expect(html).toContain('if(!own(map,url))return all')
    expect(html).toContain('(integrity|crossorigin|type)')
    /* 注释里的伪 <script>、script 正文里的字符串都不替换；<script src> 的引号/空白与属性名大小写都认 */
    expect(html).toContain("text.slice(open,open+4)==='<!--'")
    expect(html).toContain('function tagEnd(html,at)')
    expect(html).toContain('var next=tag.replace(/(\\ssrc\\s*=\\s*)(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>]+))/i')
  })

  test('S9 调整面板：组数、控件数、选项数有上限；只记与默认值不同的值，全部重置写 {}', () => {
    const html = INTELLIGENT_UI_SHELL_HTML
    expect(html).toContain('LIMIT={"groups":8,"controls":12,"options":12}')
    expect(html).toContain('TWEAKS_MAX=4096')
    expect(html).toContain("(texts.tweaks===null?null:'{}')")
    expect(html).toContain("if(d.type==='tweak.values'){tweaked(d);return}")
  })

  test('S10 range 的 coerce 与 bridge 同语义：只认有限 number，字符串不再隐式转换', () => {
    const html = INTELLIGENT_UI_SHELL_HTML
    expect(html).toContain(
      "function coerce(c,v){if(c.type==='range')return typeof v==='number'&&isFinite(v)?Math.min(c.max,Math.max(c.min,v)):c.value",
    )
    expect(html).not.toContain('var x=Number(v)')
  })

  test('S5 预置样式：特异性为零；契约列出的类名在外壳里都有，反之亦然', () => {
    const rules = BASE_CSS.split('\n').filter((line) => line.trim() !== '')
    for (const rule of rules) {
      if (rule.startsWith('*') || rule.startsWith('::selection')) continue
      expect(rule.startsWith(':where(')).toBe(true)
    }
    const inShell = new Set([...BASE_CSS.matchAll(/\.(iu-[a-z-]+)/g)].map((m) => m[1]))
    expect([...inShell].sort()).toEqual([...INTELLIGENT_UI_CLASS_NAMES].sort())
    expect(BASE_CSS).not.toContain('80vh')
  })
})
