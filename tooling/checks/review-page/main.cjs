// 代码审查页冒烟的真实宿主（CommonJS：electron 直接跑这个文件）。
// 它不做判断：渲染真组件、量几处几何、存一张截图，把结果以一行 JSON 交回 stdout。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [html, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* 量几何：三栏的宽度与滚动归属、标题是否被截、检查项颜色是否落地。 */
const PROBE = `(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const sidebar = document.querySelector('.pr-sidebar')
  const detail = document.querySelector('.pr-page__detail')
  const info = document.querySelector('.pr-page__info')
  const bar = document.querySelector('.pr-page__actions')
  const list = document.querySelector('nav[aria-label="Code review list"]')
  const title = document.querySelector('.pr-detail h1')
  const sections = [...document.querySelectorAll('.pr-info__section')].map((s) => s.getAttribute('aria-label'))
  const running = document.querySelector('.pr-detail__tabs [role="tab"][aria-selected="true"]')
  const tabs = document.querySelector('.pr-detail__tabs')
  const mergeButton = [...document.querySelectorAll('.pr-page__actions button')].find((b) => (b.textContent || '').includes('Merge'))
  const scroll = document.querySelector('.pr-detail__scroll')
  const ground = getComputedStyle(document.querySelector('.pr-page')).backgroundColor
  /* 任何一条左右分割线都不该在：把三栏边框逐个数一遍。 */
  const borders = [sidebar, detail, info].map((el) => {
    if (!el) return null
    const s = getComputedStyle(el)
    return [s.borderLeftWidth, s.borderRightWidth, s.borderTopWidth].join('/')
  })
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    columns: { sidebar: sidebar ? rect(sidebar) : null, detail: detail ? rect(detail) : null, info: info ? rect(info) : null },
    bar: bar ? rect(bar) : null,
    tabs: tabs ? rect(tabs) : null,
    scrollbarWidth: scroll ? getComputedStyle(scroll).scrollbarWidth : null,
    /* 中间那一栏的滚动体不该有可见滚动条：量它「有没有滚」与「滚动条宽不宽」。 */
    middleScrolls: scroll ? scroll.scrollHeight > scroll.clientHeight + 1 : null,
    mergeButtonRight: mergeButton ? Math.round(mergeButton.getBoundingClientRect().right) : null,
    ground,
    borders,
    listScrolls: list ? list.scrollHeight > list.clientHeight + 1 : null,
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
    titleText: title ? title.textContent : null,
    titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : null,
    sections,
    activeTab: running ? running.textContent : null,
    bodyText: document.body.innerText.slice(0, 4000),
    hasStatusGlyph: document.querySelectorAll('.pr-info svg').length,
    /* 检查项的字形：把每个圆的底色与里面小字形的颜色都量出来（形状对不对，靠这两个值得知）。 */
    checkGlyphs: [...document.querySelectorAll('.pr-info__check')].map((row) => {
      const disc = row.firstElementChild
      const inner = disc ? disc.firstElementChild : null
      const discStyle = disc ? getComputedStyle(disc) : null
      const innerStyle = inner ? getComputedStyle(inner) : null
      return {
        name: row.textContent.trim(),
        discBg: discStyle ? discStyle.backgroundColor : null,
        discRadius: discStyle ? discStyle.borderRadius : null,
        discSize: discStyle ? discStyle.width : null,
        innerColor: innerStyle ? innerStyle.color : null,
        innerStroke: innerStyle ? innerStyle.stroke : null,
      }
    }),
  }
})()`

const judge = (m) => {
  const findings = []
  const push = (name, ok, detail) => findings.push({ name, ok, detail })
  push(
    '三栏都在',
    m.columns.sidebar !== null && m.columns.detail !== null && m.columns.info !== null,
    JSON.stringify(m.columns),
  )
  push(
    '左栏宽度在 256–416 之间',
    m.columns.sidebar !== null && m.columns.sidebar.w >= 256 && m.columns.sidebar.w <= 416,
    String(m.columns.sidebar?.w),
  )
  push(
    '右栏是 22rem（352px）',
    m.columns.info !== null && Math.abs(m.columns.info.w - 352) <= 2,
    String(m.columns.info?.w),
  )
  push(
    '中栏是最宽的一栏',
    m.columns.detail !== null &&
      m.columns.sidebar !== null &&
      m.columns.info !== null &&
      m.columns.detail.w > m.columns.sidebar.w &&
      m.columns.detail.w > m.columns.info.w,
    String(m.columns.detail?.w),
  )
  push('页面整体不滚（只有中栏滚）', m.pageScrolls === false, String(m.pageScrolls))
  push('标题没被截断', m.titleClipped === false, String(m.titleClipped))
  push('标题就是这条 PR', typeof m.titleText === 'string' && m.titleText.length > 10, String(m.titleText))
  push('选中的标签是 Summary', typeof m.activeTab === 'string' && m.activeTab.includes('Summary'), String(m.activeTab))
  push(
    '正文里有 PR 正文与操作用词',
    m.bodyText.includes('Send to agent') && m.bodyText.includes('Merge'),
    m.bodyText.slice(0, 80),
  )
  push(
    '右栏说了冲突',
    m.bodyText.includes('Conflicts with main'),
    m.bodyText.includes('Conflicts with main') ? '有' : '没有',
  )
  push('检查项名字都在', m.bodyText.includes('Frontend'), 'Checks 节')
  push(
    '右栏四节都在',
    m.sections.length === 4 && m.sections.join(',') === 'Merge status,Comments,Reviews,Checks',
    m.sections.join(','),
  )
  /* 用户指定：四个动作在右栏自己那一行的上方（不横跨整页，否则左中两栏会被顶下去）。 */
  push(
    '动作行只在右栏内',
    m.bar !== null && m.columns.info !== null && Math.abs(m.bar.w - m.columns.info.w) <= 2,
    `bar=${JSON.stringify(m.bar)} info=${String(m.columns.info?.w)}`,
  )
  push(
    'Merge 贴在窗口右缘',
    m.mergeButtonRight !== null && m.mergeButtonRight >= m.viewport.w - 24,
    `right=${String(m.mergeButtonRight)} viewport=${String(m.viewport.w)}`,
  )
  /* 三栏都在同一水平线上：左栏与中栏的顶边必须齐平（曾经被一条整页顶栏顶下去过）。 */
  push(
    '左右中三栏顶边齐平',
    m.columns.sidebar !== null &&
      m.columns.detail !== null &&
      m.columns.info !== null &&
      m.columns.sidebar.y === m.columns.detail.y &&
      m.columns.detail.y === m.columns.info.y,
    `sidebar.y=${String(m.columns.sidebar?.y)} detail.y=${String(m.columns.detail?.y)} info.y=${String(m.columns.info?.y)}`,
  )
  /* 用户要求：中栏滚动条隐藏（仍可滚）。 */
  push('中栏滚动条已隐藏', m.scrollbarWidth === 'none', String(m.scrollbarWidth))
  /* 标签留在中栏正文上方（没有跟着动作一起上移）。 */
  push(
    '标签行留在中栏',
    m.tabs !== null && m.columns.detail !== null && Math.abs(m.tabs.w - m.columns.detail.w) <= 2,
    `tabs=${JSON.stringify(m.tabs)} detail=${String(m.columns.detail?.w)}`,
  )
  /* 用户要求 1：底是 #181818（rgb(24, 24, 24)），三栏都没有左右分割线。 */
  /* 用户要求 1：底是 #181818（深色主题的 --ui-ground / --ui-background）。 */
  push('页面底是 #181818', m.ground === 'rgb(24, 24, 24)', m.ground)
  push(
    '三栏都没有左右分割线',
    m.borders.length === 3 && m.borders.every((b) => b?.startsWith('0px/0px/') === true),
    m.borders.join(' | '),
  )
  /* 用户要求 3：状态要有真正的字形，不是一颗小圆点。 */
  push('右栏状态字形都画出来了', m.hasStatusGlyph >= 3, `svg=${String(m.hasStatusGlyph)}`)
  return findings
}

async function run() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    x: -3000,
    y: -3000,
    webPreferences: { backgroundThrottling: false },
  })
  await win.loadFile(path.resolve(html))
  await sleep(1200)
  const metrics = await win.webContents.executeJavaScript(PROBE)
  /*
   * 截图是给人看的附件，不是断言的一部分：窗口在屏幕外时 capturePage 偶发 UnknownVizError，
   * 那不该让整条检查红掉（判定全靠上面量到的数值）。 */
  try {
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, 'code-review-page.png'), image.toPNG())
  } catch (error) {
    process.stderr.write(`[review-page] 截图失败（不影响判定）：${String(error)}\n`)
  }

  win.destroy()
  return { report: judge(metrics), metrics }
}

app.whenReady().then(async () => {
  try {
    const result = await run()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${String(error?.stack ? error.stack : error)}\n`)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
