#!/usr/bin/env bun
/**
 * 分隔条焦点探针：在真 Chromium 里验「拖完抓手是否立刻灭」。
 *
 * 为什么需要它：抓手可见性由 workspace-shell.css 里那条
 * `:has(.workspace-region-splitter[data-edge=…]:focus-visible)` 决定，而 :focus-visible
 * 是浏览器的启发式 —— bun test / jsdom 里根本不存在，只能拿真引擎验。它曾经把脚本
 * focus() 算成「键盘来的」，抓手因此常亮到下一次点击才灭（region-splitter.tsx 的
 * pointerdown 里现在不 focus()，理由写在那里）。
 *
 * 页面按真实规则搭：CSS 抄 workspace-shell.css 的三条，处理器顺序抄 region-splitter.tsx。
 * 不进 CI —— 它要一个 Chromium 二进制（WebView2 跑的就是同一个引擎）。
 *
 * 跑法：bun tools/dev/probe-splitter-focus.ts [--browser <exe>]
 * 退出码 0 = 行为正确。
 */

import process from 'node:process'

const DEFAULT_BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
]

const argument = process.argv.indexOf('--browser')
const browser = argument === -1 ? (process.env['DSH_CHROMIUM'] ?? '') : process.argv[argument + 1]
const exe = browser === '' ? DEFAULT_BROWSERS.find((path) => Bun.file(path).size > 0) : browser

if (exe === undefined) {
  console.error('找不到 Chromium：用 --browser <exe> 或 DSH_CHROMIUM 指一个。')

  process.exit(2)
}

/* CSS 正本：apps/desktop/src/shell/workspace-shell.css 的 .workspace-shell__divider 三条。 */
const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 700px; }
  .workspace-shell { position: relative; height: 700px; }
  .sidebar { position: relative; height: 700px; background: #fafafa; }
  .workspace-region-splitter { position: absolute; top: 0; right: 0; height: 100%; border: 0;
    background: transparent; width: 8px; transform: translateX(50%); cursor: col-resize;
    outline: none; touch-action: none; user-select: none; }
  .workspace-shell__divider { position: absolute; top: 0; bottom: 0; width: 0; z-index: 2; pointer-events: none; }
  .workspace-shell__divider::after { content: ""; position: absolute; top: 6%; bottom: 6%; left: -0.75px;
    width: 1.5px; background: #333; opacity: 0; transition: opacity 0.22s ease; }
  .workspace-shell[data-splitter="hover"] .workspace-shell__divider::after { opacity: 1; transition-delay: 50ms; }
  .workspace-shell[data-splitter="drag"] .workspace-shell__divider::after { opacity: 1; }
  .workspace-shell:has(.workspace-region-splitter[data-edge="inline-start"]:focus-visible)
    .workspace-shell__divider::after { opacity: 1; }
</style>
<div class="workspace-shell" id="shell" data-splitter="idle">
  <div class="sidebar" id="sidebar" style="width:300px">
    <hr class="workspace-region-splitter" id="h" data-edge="inline-start" tabindex="0" aria-label="调整侧边栏宽度">
  </div>
  <div class="workspace-shell__divider" id="divider" style="left:300px"></div>
</div>
<script>
  const shell = document.getElementById('shell')
  const sidebar = document.getElementById('sidebar')
  const divider = document.getElementById('divider')
  const h = document.getElementById('h')
  let session = null
  const onActivity = (a) => { shell.dataset.splitter = a }
  const clamp = (n) => Math.max(220, Math.min(460, Math.round(n)))
  const paint = (w) => { sidebar.style.width = w + 'px'; divider.style.left = w + 'px' }
  const over = (p) => { const r = h.getBoundingClientRect()
    return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom }
  const settle = (s, activity) => {
    session = null
    if (h.hasPointerCapture(s.id)) h.releasePointerCapture(s.id)
    onActivity(activity)
  }
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || session !== null) return
    e.stopPropagation()
    session = { id: e.pointerId, startX: e.clientX, startWidth: sidebar.getBoundingClientRect().width,
      point: { x: e.clientX, y: e.clientY } }
    onActivity('drag')
    h.setPointerCapture(e.pointerId)
  })
  h.addEventListener('pointermove', (e) => {
    if (!session || session.id !== e.pointerId) return
    session.point = { x: e.clientX, y: e.clientY }
    paint(clamp(session.startWidth + (e.clientX - session.startX)))
  })
  const end = (e) => {
    if (!session || session.id !== e.pointerId) return
    settle(session, over(session.point) ? 'hover' : 'idle')
  }
  h.addEventListener('pointerup', end)
  h.addEventListener('lostpointercapture', end)
  h.addEventListener('pointercancel', end)
  h.addEventListener('pointerenter', () => { if (!session) onActivity('hover') })
  h.addEventListener('pointerleave', () => { if (!session) onActivity('idle') })
  document.addEventListener('pointerleave', () => { if (session) settle(session, 'idle'); else onActivity('idle') },
    { passive: true })

  window.rect = () => { const r = h.getBoundingClientRect()
    return { l: Math.round(r.left), w: Math.round(r.width) } }
  window.probe = () => ({
    fv: h.matches(':focus-visible'),
    grip: Number(getComputedStyle(divider, '::after').opacity),
    width: Math.round(sidebar.getBoundingClientRect().width),
  })
</script>`

const port = 9300 + Math.floor(Math.random() * 400)
const profile = `${process.env['TEMP'] ?? '/tmp'}/poietica-splitter-probe-${String(port)}`
const engine = Bun.spawn([
  exe,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,860',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${String(port)}`,
  'about:blank',
])

async function firstPage(): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()) as {
        type: string
        webSocketDebuggerUrl: string
      }[]
      const page = list.find((target) => target.type === 'page')

      if (page !== undefined) {
        return page
      }
    } catch {
      /* 引擎还没起来 */
    }

    await Bun.sleep(200)
  }

  throw new Error('Chromium 没在 20 秒内开出调试端口。')
}

const page = await firstPage()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))

let sequence = 0
const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data)) as {
    id?: number
    result?: unknown
    error?: unknown
  }

  if (message.id !== undefined) {
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  }
})

const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  new Promise((resolve, reject) => {
    sequence += 1
    const id = sequence
    waiting.set(id, (message) => {
      if (message.error === undefined) {
        resolve(message.result)
      } else {
        reject(new Error(JSON.stringify(message.error)))
      }
    })
    socket.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression: string): Promise<never> =>
  (
    (await send('Runtime.evaluate', { expression, returnByValue: true })) as {
      result: { value: never }
    }
  ).result.value

interface Reading {
  readonly fv: boolean
  readonly grip: number
  readonly width: number
}

const mouse = (type: string, x: number, y: number): Promise<unknown> =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' || type === 'mouseMoved' ? 0 : 1,
    clickCount: 1,
  })

const press = async (key: string, code: string, virtual: number, raw = false): Promise<void> => {
  await send('Input.dispatchKeyEvent', {
    type: raw ? 'rawKeyDown' : 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: virtual,
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual })
}

const failures: string[] = []
const check = (what: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what} — ${detail}`)

  if (!ok) {
    failures.push(what)
  }
}

const load = async (): Promise<void> => {
  await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}` })
  await Bun.sleep(400)
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
}

await send('Page.enable')
await send('Runtime.enable')

/* 一、普通鼠标拖拽：松手那一刻 :focus-visible 必须是假 —— 这就是那次回归。 */
await load()
let bar = (await evaluate('window.rect()')) as { l: number; w: number }
let x = bar.l + bar.w / 2
await mouse('mouseMoved', x, 300)
await mouse('mousePressed', x, 300)
await mouse('mouseMoved', x - 140, 300)
await mouse('mouseReleased', x - 140, 300)
await Bun.sleep(300)
let reading = (await evaluate('window.probe()')) as Reading
check(
  '鼠标拖后焦点环不亮',
  !reading.fv,
  `:focus-visible=${String(reading.fv)} 宽=${String(reading.width)}`,
)
await mouse('mouseMoved', x + 400, 520)
await Bun.sleep(400)
reading = (await evaluate('window.probe()')) as Reading
check('指针移开后抓手灭', reading.grip < 0.05, `抓手不透明度=${String(reading.grip)}`)

/* 二、键盘先动过再拖：启发式原本就是被这一步喂出来的，回归从这里长出来。 */
await load()
await mouse('mousePressed', 60, 460)
await mouse('mouseReleased', 60, 460)
await press('a', 'KeyA', 65, true)
await press('b', 'KeyB', 66, true)
bar = (await evaluate('window.rect()')) as { l: number; w: number }
x = bar.l + bar.w / 2
await mouse('mouseMoved', x, 300)
await mouse('mousePressed', x, 300)
await mouse('mouseMoved', x - 140, 300)
await mouse('mouseReleased', x - 140, 300)
await Bun.sleep(300)
reading = (await evaluate('window.probe()')) as Reading
check('键盘交互后鼠标拖，焦点环也不亮', !reading.fv, `:focus-visible=${String(reading.fv)}`)
await mouse('mouseMoved', x + 400, 520)
await Bun.sleep(400)
reading = (await evaluate('window.probe()')) as Reading
check(
  '键盘交互后鼠标拖，指针移开抓手灭',
  reading.grip < 0.05,
  `抓手不透明度=${String(reading.grip)}`,
)

/* 三、键盘可达性：Tab 走到条上，焦点环得看得见（这是不能拿掉的另一半）。 */
await load()
await mouse('mousePressed', 60, 460)
await mouse('mouseReleased', 60, 460)
await press('Tab', 'Tab', 9, true)
await Bun.sleep(300)
reading = (await evaluate('window.probe()')) as Reading
check(
  'Tab 聚焦时焦点环亮',
  reading.fv && reading.grip > 0.5,
  `:focus-visible=${String(reading.fv)} 抓手=${String(reading.grip)}`,
)

socket.close()
engine.kill()

console.log(failures.length === 0 ? '\n全部通过。' : `\n${String(failures.length)} 项未通过。`)
process.exit(failures.length === 0 ? 0 : 1)
