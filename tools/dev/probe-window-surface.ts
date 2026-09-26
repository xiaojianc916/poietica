#!/usr/bin/env bun
/**
 * 窗口衬底探针：在真 Chromium 里验「拖拽露底那一层与外壳同色」。
 *
 * 为什么需要它：衬底色分三处落地（index.html 的预运行初稿、theme-runtime 的 RGB
 * 投影、tauri.conf.json 的创建底色），而拖拽露底是原生合成 —— bun test 里没有
 * DOM，架构闸门只能核对三处**字面值**相等，核对不了「屏幕上量出来是不是同一个
 * 颜色」。这条探针补的就是后半句：加载真实构建产物，让样式引擎把 --ui-chrome
 * 解析成 rgb()，再与衬底逐通道比。
 *
 * 页面用 dist 里的真产物，不手抄 CSS：手抄件会跟着正本一起腐烂，量出来的绿色
 * 只证明抄对了，不证明应用对了。
 *
 * 不进 CI —— 它要一个 Chromium 二进制（WebView2 跑的就是同一个引擎）。
 *
 * 跑法：bun tools/dev/probe-window-surface.ts [--browser <exe>]
 * 前置：bun run build:web（读 apps/desktop/dist）
 * 退出码 0 = 行为正确。
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { attach, checker, firstPage, launchEngine, resolveBrowser } from './probe-cdp'

const exe = resolveBrowser()

const DIST = path.resolve(import.meta.dir, '../../apps/desktop/dist')
const index = Bun.file(path.join(DIST, 'index.html'))

if (index.size === 0) {
  console.error(`${DIST}/index.html 不存在：先跑 bun run build:web。`)

  process.exit(2)
}

/*
 * 衬底正本：apps/desktop/src-tauri/tauri.conf.json 与 theme-runtime.ts 的浅色表面。
 * 这里写字面值是有意的 —— 探针要能独立于源码说「屏幕上是这个色」，读源码再比
 * 就成了自证。
 */
const EXPECTED = { light: '#f3f3f3', dark: '#202020' } as const

const port = 9700 + Math.floor(Math.random() * 200)
const profile = `${process.env['TEMP'] ?? '/tmp'}/poietica-surface-probe-${String(port)}`

/*
 * 产物走 HTTP 伺服，不走 file://：构建产物的资源路径是绝对的（/assets/...），
 * file:// 下会解析到文件系统根，样式表全 404。Tauri 生产环境也是从 tauri://
 * 伺服同一份 dist，所以这里更接近真实。
 */
const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    const target = path.join(DIST, pathname === '/' ? 'index.html' : pathname)
    const file = Bun.file(target)

    if (!(await file.exists())) {
      return new Response('not found', { status: 404 })
    }

    return new Response(file, {
      headers: { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' },
    })
  },
})

const engine = launchEngine(exe, port, profile, '1280,860')

const probe = await attach(await firstPage(port), engine)

const { check, passed, failureCount } = checker()

/*
 * 探针页面：只加载真实产物 CSS，自己铺一个 .workspace-shell 的地色格。
 * 探针元素用 --ui-chrome 上色，样式引擎解析出的 rgb() 就是外壳在屏幕上的颜色。
 *
 * 求值的是 async IIFE 而不是 <script> 标签：Runtime.evaluate 求值表达式，
 * 一段 HTML 文本只会原样返回，脚本永远不会跑。
 */
const PROBE = `(async () => {
  const links = [...document.querySelectorAll('link[rel=stylesheet]')]
  await Promise.all(links.map((l) => l.sheet ? null : new Promise((r) => { l.onload = r; l.onerror = r })))

  const probe = document.createElement('div')
  probe.style.background = 'var(--ui-chrome)'
  document.body.append(probe)

  const channel = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value)
    if (!m) return null
    const parts = m[1].split(/[,\\s/]+/).filter(Boolean).slice(0, 3).map(Number)
    return parts.length === 3 && parts.every((n) => Number.isInteger(n)) ? parts : null
  }

  window.probe = () => {
    const root = getComputedStyle(document.documentElement)
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      chrome: channel(getComputedStyle(probe).backgroundColor),
      chromeToken: root.getPropertyValue('--ui-chrome').trim(),
      backing: root.getPropertyValue('--window-backing-surface').trim(),
      backingUsed: channel(getComputedStyle(document.body).backgroundColor),
      neutral75: root.getPropertyValue('--ui-palette-neutral-75').trim(),
      dark850: root.getPropertyValue('--ui-palette-dark-850').trim(),
      themeColor: document.querySelector('meta[name=theme-color]')?.getAttribute('content') ?? null,
    }
  }
  window.setTheme = (t) => { document.documentElement.setAttribute('data-theme', t) }
  return document.styleSheets.length
})()`

await probe.send('Page.enable')
await probe.send('Runtime.enable')

const fileUrl = `http://127.0.0.1:${String(server.port)}/`
await probe.send('Page.navigate', { url: fileUrl })
await Bun.sleep(1500)
const sheetCount = await probe.evaluate(PROBE, true)
await Bun.sleep(400)

console.log(`引擎：${exe}`)
console.log(`产物：${path.join(DIST, 'index.html')} @ ${fileUrl}`)
console.log(`样式表：${String(sheetCount)} 张\n`)

interface Reading {
  readonly theme: string | null
  readonly chrome: number[] | null
  readonly chromeToken: string
  readonly backing: string
  readonly backingUsed: number[] | null
  readonly neutral75: string
  readonly dark850: string
  readonly themeColor: string | null
}

const hexToRgb = (hex: string): number[] =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
const show = (rgb: number[] | null): string => (rgb === null ? 'null' : `rgb(${rgb.join(' ')})`)

const close = (code: number): never => {
  probe.close()
  void server.stop(true)
  process.exit(code)
}

/* 一、样式表确实加载了：量不到色就说明产物或路径不对，后面的断言全部无意义。 */
let reading = (await probe.evaluate('window.probe()')) as Reading

if (reading === undefined || reading.chrome === null || reading.neutral75 === '') {
  console.error('设计系统样式表没加载进探针页面，量不到 --ui-chrome。')

  close(2)
}

/* 二、浅色：外壳解析色 == 衬底正本 == #f3f3f3。 */
const lightExpected = hexToRgb(EXPECTED.light)
check(
  '浅色：外壳 --ui-chrome 解析为衬底色',
  JSON.stringify(reading.chrome) === JSON.stringify(lightExpected),
  `--ui-chrome = ${show(reading.chrome)}，期望 ${show(lightExpected)}`,
)
check(
  '浅色：调色板正本 = 衬底色',
  reading.neutral75.toLowerCase() === EXPECTED.light,
  `--ui-palette-neutral-75 = ${reading.neutral75}`,
)
check(
  '浅色：theme-color 静态初值 = 衬底色',
  reading.themeColor?.toLowerCase() === EXPECTED.light,
  `theme-color = ${String(reading.themeColor)}`,
)

/*
 * 三、深色：切 data-theme 后外壳必须跟着换。
 * body 的 --window-backing-surface 是 index.html 那份预运行初稿，只由
 * prefers-color-scheme 驱动；这里验的是运行期外壳与调色板深色正本一致。
 */
await probe.evaluate("window.setTheme('dark')")
await Bun.sleep(300)
reading = (await probe.evaluate('window.probe()')) as Reading

const darkExpected = hexToRgb(EXPECTED.dark)
check(
  '深色：外壳 --ui-chrome 解析为深色衬底色',
  JSON.stringify(reading.chrome) === JSON.stringify(darkExpected),
  `--ui-chrome = ${show(reading.chrome)}，期望 ${show(darkExpected)}`,
)
check(
  '深色：调色板正本 = 深色衬底色',
  reading.dark850.toLowerCase() === EXPECTED.dark,
  `--ui-palette-dark-850 = ${reading.dark850}`,
)

/* 四、深浅两色确实不同：同一个值会让上面两条同时成立而界面毫无变化。 */
check(
  '深浅两档不同色',
  reading.neutral75.toLowerCase() !== reading.dark850.toLowerCase(),
  `${reading.neutral75} vs ${reading.dark850}`,
)

/* 五、预运行初稿：把媒体特性模拟成深色，body 的地色必须换成深色衬底。 */
await probe.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
})
await probe.evaluate("window.setTheme('light')")
await Bun.sleep(300)
reading = (await probe.evaluate('window.probe()')) as Reading
check(
  '深色系统偏好下：预运行初稿 = #202020',
  JSON.stringify(reading.backingUsed) === JSON.stringify(darkExpected),
  `--window-backing-surface = ${reading.backing}，body 解析 = ${show(reading.backingUsed)}`,
)

await probe.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
})
await Bun.sleep(300)
reading = (await probe.evaluate('window.probe()')) as Reading
check(
  '浅色系统偏好下：预运行初稿 = #f3f3f3',
  JSON.stringify(reading.backingUsed) === JSON.stringify(lightExpected),
  `--window-backing-surface = ${reading.backing}，body 解析 = ${show(reading.backingUsed)}`,
)

/* 报告产物清单，便于确认量的是哪一份构建。 */
const assets = (await readdir(path.join(DIST, 'assets'))).filter((name) => name.endsWith('.css'))
console.log(`\n样式产物：${assets.join(', ')}`)
console.log(passed() ? '全部通过。' : `${String(failureCount())} 项未通过。`)
close(passed() ? 0 : 1)
