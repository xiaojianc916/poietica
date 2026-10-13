// 真实布局检查的宿主（CommonJS：electron 直接跑这个文件）。
//
// 一个场景一个进程：少动效那一档要靠 --force-prefers-reduced-motion 启动开关，而 motion 首次读取
// 系统偏好后就缓存，同一进程里改不了。
//
// 窗口放在屏幕外但保持可见（x/y 为负、show: true）：隐藏窗口的 rAF 会被 Chromium 节流，测出来的
// 帧率、延迟与抖动都没有意义。backgroundThrottling 再关一次。
//
// 它不做判断：跑完把原始采样以一行 JSON 交回 stdout，指标与阈值归 run.ts（metrics.ts）。
// 帧率不够（< 50fps）时退出码 2 —— 环境不合格就不给结论。收尾等页面的 `window.__done`。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [html, scenarioRaw, outDir] = process.argv.slice(2)
const scenario = JSON.parse(scenarioRaw)

if (scenario.reduced === true) app.commandLine.appendSwitch('force-prefers-reduced-motion')

/** 收尾的硬上限：__done 一直不来（引擎卡住）也必须交回结论，不能把检查台挂在这里。 */
const HARD_LIMIT_MS = 20_000
/** 判定 __done 之后再多采一会儿：收尾那几帧（放干、停滑）也要进采样。 */
const SETTLE_MS = 400
const FPS_WINDOW_MS = 1000
const MIN_FPS = 50
const SHOT_AT_MS = [1500, 4500, 8000]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function measureFps(win) {
  return win.webContents.executeJavaScript(
    `new Promise((resolve) => {
       let frames = 0
       const start = performance.now()
       const tick = () => {
         frames += 1
         const elapsed = performance.now() - start
         if (elapsed >= ${String(FPS_WINDOW_MS)}) resolve((frames / elapsed) * 1000)
         else requestAnimationFrame(tick)
       }
       requestAnimationFrame(tick)
     })`,
  )
}

async function runScenario() {
  const win = new BrowserWindow({
    width: 840,
    height: 160,
    show: true,
    x: -2000,
    y: -2000,
    webPreferences: { backgroundThrottling: false },
  })
  const started = Date.now()
  const search = new URLSearchParams({
    arrivals: JSON.stringify(scenario.arrivals),
    resize: scenario.resize ? '1' : '0',
    reduced: scenario.reduced ? '1' : '0',
  }).toString()

  await win.loadFile(path.resolve(html), { search })

  const fps = await measureFps(win)

  if (fps < MIN_FPS) {
    win.destroy()

    return { id: scenario.id, fps, skipped: true }
  }

  for (const at of SHOT_AT_MS) {
    await sleep(Math.max(0, started + at - Date.now()))
    fs.writeFileSync(
      path.join(outDir, `${scenario.id}-${String(at)}.png`),
      (await win.webContents.capturePage()).toPNG(),
    )
  }

  const deadline = started + HARD_LIMIT_MS

  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript('window.__done === true')) {
      await sleep(SETTLE_MS)
      break
    }

    await sleep(50)
  }

  const payload = await win.webContents.executeJavaScript(
    '({ samples: window.__samples ?? [], arrivals: window.__arrivals ?? [] })',
  )

  win.destroy()

  return { id: scenario.id, fps, samples: payload.samples, arrivals: payload.arrivals }
}

app.whenReady().then(async () => {
  try {
    process.stdout.write(`${JSON.stringify(await runScenario())}\n`)
  } catch (error) {
    process.stderr.write(`[ticker-layout] ${error?.stack ?? String(error)}\n`)
    process.exitCode = 1
  }

  app.quit()
})

app.on('window-all-closed', () => {})
