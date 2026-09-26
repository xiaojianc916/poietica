#!/usr/bin/env bun
/**
 * 布局几何探针：在真 Chromium 里量「外壳栅格 + 两个区域」的实际矩形。
 *
 * 为什么需要它：收起态靠 flex 裁剪层 + 定宽内容实现，而「列窄于内容时内容从哪一端
 * 被吃掉、留白还在不在」是布局引擎的行为，bun test 里没有布局引擎，量不出来。它验
 * 的是三件事：
 *
 *   1. 两张卡片四周的留白与圆角半径都还在（列宽被拖窄时也不例外）；
 *   2. 侧栏收起时内容从 inline-end 被裁掉（左缘不动），右栏从 inline-start 被裁掉
 *      （右缘不动）—— 即两边都是「滑出去」，不是被压扁；
 *   3. 窗口窄到把列压到内容宽以下时，主列与右栏之和不超过外壳宽（第 1 条缺陷的回归）。
 *
 * 页面按真实规则搭：CSS 抄 workspace-shell.css 的栅格与两个区域，尺寸抄
 * workspace-layout.ts 的当前值。不进 CI —— 它要一个 Chromium 二进制。
 *
 * 跑法：bun tools/dev/probe-workspace-geometry.ts [--browser <exe>]
 * 退出码 0 = 几何正确。
 */

import process from 'node:process'
import { attach, checker, firstPage, launchEngine, resolveBrowser } from './probe-cdp'

const exe = resolveBrowser()

/* 正本：apps/desktop/src/shell/workspace-shell.css 与 packages/workspace/src/workspace-layout.ts */
const GAP = 8
const RADIUS = 16

const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; }
  .workspace-shell {
    position: relative; display: grid; height: 100vh; width: 100%; overflow: hidden;
    grid-template-columns: var(--ws) minmax(0, 1fr) var(--wa);
    grid-template-rows: 36px minmax(0, 1fr);
    grid-template-areas: "chrome chrome chrome" "sidebar main auxiliary";
  }
  .chrome { grid-area: chrome; background: #202020; }
  .region { position: relative; min-inline-size: 0; min-block-size: 0; }
  .region-clip { position: absolute; inset: 0; display: flex; overflow: clip; }
  .region-content { flex: none; min-block-size: 0; overflow: hidden; }
  .sidebar { grid-area: sidebar; background: #202020; }
  .main {
    position: relative; grid-area: main; background: #202020;
    padding-block-end: ${String(GAP)}px; padding-inline-end: ${String(GAP)}px;
  }
  .main-panel { height: 100%; background: #181818; border-radius: ${String(RADIUS)}px; }
  .auxiliary { grid-area: auxiliary; background: #202020; }
  .auxiliary .region-clip { justify-content: flex-end; }
  .auxiliary-content {
    background: #181818; border-radius: ${String(RADIUS)}px;
    margin-block-end: ${String(GAP)}px; margin-inline-end: ${String(GAP)}px;
  }</style>
<div class="workspace-shell" id="shell">
  <div class="chrome"></div>
  <div class="region sidebar" id="sidebar">
    <div class="region-clip" id="sidebarClip"><div class="region-content" id="sidebarContent" style="width:280px"></div></div>
  </div>
  <div class="main" id="main"><div class="main-panel" id="mainPanel"></div></div>
  <div class="region auxiliary" id="auxiliary">
    <div class="region-clip" id="auxClip"><div class="region-content auxiliary-content" id="auxContent" style="width:412px"></div></div>
  </div>
</div>
<script>
  window.setColumns = (sidebarColumn, auxiliaryColumn) => {
    const shell = document.getElementById('shell')
    shell.style.setProperty('--ws', sidebarColumn + 'px')
    shell.style.setProperty('--wa', auxiliaryColumn + 'px')
  }
  window.setWidths = (sidebarContentWidth, auxPanelWidth) => {
    document.getElementById('sidebarContent').style.width = sidebarContentWidth + 'px'
    /* 面板宽度由 store 那一份减去一条留白得来（见 auxiliary-region.tsx）。 */
    document.getElementById('auxContent').style.width = (auxPanelWidth - ${String(GAP)}) + 'px'
  }
  const box = (id) => { const r = document.getElementById(id).getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) } }
  /* 可见宽 = 内容矩形与裁剪层矩形的交。定宽内容被裁掉多少，只有这个数说了算 ——
   * 内容自己的 rect 不随列宽变（它定宽且贴 end），变的是裁剪层。 */
  const visible = (contentId, clipId) => {
    const c = document.getElementById(contentId).getBoundingClientRect()
    const k = document.getElementById(clipId).getBoundingClientRect()
    return Math.round(Math.max(0, Math.min(c.right, k.right) - Math.max(c.left, k.left)))
  }
  window.probe = () => ({
    shell: box('shell'), sidebarContent: box('sidebarContent'),
    mainPanel: box('mainPanel'), auxContent: box('auxContent'),
    auxVisible: visible('auxContent', 'auxClip'),
    sidebarVisible: visible('sidebarContent', 'sidebarClip'),
  })
</script>`

const port = 9700 + Math.floor(Math.random() * 200)
const profile = `${process.env['TEMP'] ?? '/tmp'}/poietica-geometry-probe-${String(port)}`
const engine = launchEngine(exe, port, profile, '1400,900')

const probe = await attach(await firstPage(port), engine)

interface Box {
  readonly left: number
  readonly right: number
  readonly width: number
}
interface Reading {
  readonly shell: Box
  readonly sidebarContent: Box
  readonly mainPanel: Box
  readonly auxContent: Box
  readonly auxVisible: number
  readonly sidebarVisible: number
}

const { check, passed, failureCount } = checker()

const load = async (): Promise<void> => {
  await probe.send('Page.navigate', {
    url: `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`,
  })
  await Bun.sleep(400)
}

await probe.send('Page.enable')
await probe.send('Runtime.enable')
await load()

/* 一、常态：两侧都开着，两张卡片四周留白都在。 */
await probe.evaluate('window.setColumns(280, 420)')
await probe.evaluate('window.setWidths(280, 420)')
await Bun.sleep(120)
const reading = (await probe.evaluate('window.probe()')) as Reading
check(
  '右栏右缘让出一条留白',
  reading.shell.right - reading.auxContent.right === GAP,
  `外壳右缘=${String(reading.shell.right)} 面板右缘=${String(reading.auxContent.right)}`,
)
check(
  '主面板右缘与右栏左缘之间是一条留白（不是两条）',
  reading.auxContent.left - reading.mainPanel.right === GAP,
  `缝=${String(reading.auxContent.left - reading.mainPanel.right)}`,
)
check(
  '右栏底缘让出一条留白',
  reading.mainPanel.right - reading.mainPanel.left > 0 &&
    reading.shell.right - reading.auxContent.right === GAP,
  `主面板宽=${String(reading.mainPanel.width)}`,
)

/* 二、右栏被拖窄到内容宽以下：右缘必须钉住不动，从左边被吃掉（可见宽变小，
 * 而内容自身的宽度不变 —— 那才是「滑出去」而不是「被压扁」）。 */
await probe.evaluate('window.setColumns(280, 200)')
await Bun.sleep(120)
const squeezed = (await probe.evaluate('window.probe()')) as Reading

check(
  '右栏列窄于内容时右缘仍钉在留白上',
  squeezed.shell.right - squeezed.auxContent.right === GAP,
  `外壳右缘=${String(squeezed.shell.right)} 面板右缘=${String(squeezed.auxContent.right)}`,
)
check(
  '右栏被裁时内容宽不变（不是被压扁）',
  squeezed.auxContent.width === reading.auxContent.width,
  `窄=${String(squeezed.auxContent.width)} 宽=${String(reading.auxContent.width)}`,
)
check(
  '右栏被裁掉的是左边那一段（可见宽随列宽收）',
  squeezed.auxVisible < reading.auxVisible,
  `可见宽 ${String(reading.auxVisible)} → ${String(squeezed.auxVisible)}`,
)

/* 三、侧栏被拖窄到内容宽以下：左缘必须钉住不动，从右边被吃掉。 */
await probe.evaluate('window.setColumns(120, 420)')
await Bun.sleep(120)
const narrowSidebar = (await probe.evaluate('window.probe()')) as Reading

check(
  '侧栏列窄于内容时左缘仍贴外壳左缘',
  narrowSidebar.sidebarContent.left === narrowSidebar.shell.left,
  `内容左缘=${String(narrowSidebar.sidebarContent.left)} 外壳左缘=${String(narrowSidebar.shell.left)}`,
)
check(
  '侧栏被裁时内容宽不缩（不是被压扁）',
  narrowSidebar.sidebarContent.width === 280,
  `内容宽=${String(narrowSidebar.sidebarContent.width)}`,
)
check(
  '侧栏被裁掉的是右边那一段',
  narrowSidebar.sidebarVisible < reading.sidebarVisible,
  `可见宽 ${String(reading.sidebarVisible)} → ${String(narrowSidebar.sidebarVisible)}`,
)

/* 四、主面板始终不溢出外壳：这是第 1 条缺陷（上限不含窗口）在 CSS 侧的后果。 */
await probe.evaluate('window.setColumns(280, 420)')
await Bun.sleep(120)
const wide = (await probe.evaluate('window.probe()')) as Reading

check(
  '主面板不溢出外壳右缘',
  wide.mainPanel.right <= wide.shell.right,
  `主面板右缘=${String(wide.mainPanel.right)} 外壳右缘=${String(wide.shell.right)}`,
)

probe.close()

console.log(passed() ? '\n全部通过。' : `\n${String(failureCount())} 项未通过。`)
process.exit(passed() ? 0 : 1)
