/*
 * 应用组合根：窗口、托盘、主题、退出屏障，以及渲染层到原生宿主的那一跳。
 *
 * 渲染层永远拿不到 require/ipcRenderer/fs：能力只从 preload.ts 的桥进来，
 * 命令落到 ipc-router.ts（转原生）、browser/host.ts（标签是宿主自己的状态）或
 * update.ts（更新同样是宿主的能力）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, Session } from 'electron'
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  protocol,
  session,
  shell,
  Tray,
} from 'electron'

import { createAssetProtocolHandler } from './asset-protocol'
import type { BrowserHost } from './browser/host'
import { applyBrowserCommand, BROWSER_PARTITION, createBrowserHost } from './browser/host'
import { type BrowserRelay, createBrowserRelay, DEFAULT_RELAY_URL } from './browser/relay'
import { prepareDataRoot } from './data-root'
import type { Router } from './ipc-router'
import { createRouter } from './ipc-router'
import { installLogging, setLogLevel } from './logging'
import type { NativeHost } from './native'
import { loadNative } from './native'
import { SESSION_DIRECTORY } from './session-directory'
import { createStorageCommands, type StorageCommands, type StorageSessionPort } from './storage'
import type { UpdateCommands } from './update'
import { createUpdateCommands, loadUpdater } from './update'

/** 自定义协议的特权必须在 app ready 前登记，且只能登记一次。standard 给 origin，stream 给 <video> 的 Range。 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'poietica-asset',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

const MAIN_WINDOW = 'main'

type ThemePreference = 'light' | 'dark' | 'system'

const DENIED = 'poietica: permissionDenied — 这条通道只对主界面开放'

/** 主进程侧的传输：{ command, args } 进，{ ok } | { error } 出 —— 与原生侧的线上形状一字不差。 */
type Reply =
  | { ok: true; value: unknown }
  | { ok: false; problem: unknown }
  | { ok: false; message: string }

const ok = (value: unknown): Reply => ({ ok: true, value })
const refusal = (message: string): Reply => ({ ok: false, message })

let mainWindow: BrowserWindow | null = null
let browserHost: BrowserHost | null = null
let browserRelay: BrowserRelay | null = null
let nativeHost: NativeHost | null = null
let router: Router | null = null
let storageCommands: StorageCommands | null = null
let tray: Tray | null = null
let quitting = false

/**
 * 原生侧启动完成的那一拍。
 *
 * 命令面要等它：窗口比 `native.start()` 早建好，渲染层首帧那十几条读会赶在运行时
 * 接好之前落进原生侧，撞出一批假的「连不上 agent」（见 installHandlers 里的说明）。
 * 成功与失败都算「跑完了」—— 失败由那一次命令自己如实报回来。
 *
 * **必须在模块顶层就把这个 promise 建出来**：装上处理器（installHandlers）到 start 之间
 * 还有好几百毫秒，渲染层正是那一段发起首帧的读。先在 start 那里建，那段窗口里读到的
 * 还是一个已经兑现的 promise —— 门形同虚设，假故障照旧。
 */
let settleNativeReady: () => void = () => undefined
const nativeReady: Promise<void> = new Promise<void>((resolve) => {
  settleNativeReady = resolve
})

/*
 * 更新的相位活在主进程里（update.ts）；electron-updater 到第一次调用才装载。
 *
 * 下载进度从这里发出去：通道名与原生事件同一条规则（`poietica:event:` + 线上名），
 * 渲染层按名字订阅，主进程不替它挑形状。
 */
const updateCommands: UpdateCommands = createUpdateCommands(loadUpdater, (progress) => {
  send('poietica:event:update-progress', progress)
})

const single = app.requestSingleInstanceLock()

if (single) {
  app.on('second-instance', () => {
    activate(mainWindow)
  })

  void app
    .whenReady()
    .then(main)
    .catch((cause: unknown) => {
      console.error(cause)
      dialog.showErrorBox(
        'Poietica 启动失败',
        cause instanceof Error ? cause.message : String(cause),
      )
      app.exit(1)
    })
} else {
  // 第二次启动：把活着的那个窗口叫到前面来，自己退场。
  app.quit()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/*
 * 窗口清单归 Electron 自己持有：广播就是遍历 BrowserWindow.getAllWindows()。
 *
 * 不用一个「唯一窗口」的指针当闸门 —— 那个指针在窗口重建、托盘唤起与「关掉再打开」
 * 这三条路上都要人工跟着改，而框架本来就知道现在有哪几个窗口。窗口销毁后 getAllWindows
 * 里就没有它，isDestroyed 只是防同一拍里的竞态。
 *
 * 今天这个应用只建一个窗口（devtools 与内置浏览器都是 WebContentsView / 独立 devtools
 * 目标，不是 BrowserWindow），所以这条广播的收件人恰好是一个 —— 但收件人由框架数，不由
 * 这份代码假定。
 */
function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

function activate(win: BrowserWindow | null): void {
  if (win === null || win.isDestroyed()) {
    return
  }

  if (win.isMinimized()) {
    win.restore()
  }

  win.show()
  win.focus()
}

function presentBrowserState(): void {
  send('poietica:event:browser-state', browserHost?.state() ?? null)
}

/*
 * 通道名的唯一规则：`poietica:event:` + 线上那个名字，一个字符都不改。
 *
 * 原生侧 `transport::emit("agent_session_event")` 发什么，生成物的
 * `events.agentSessionEvent` 就订阅什么；主进程自己发的 browser-state /
 * browser-element-picked / window-maximized 那几个同理。此前这里做了一次
 * snake_case → kebab-case 的「归一」，结果是**每一条原生事件都发到了没人听的通道上**
 * —— 屏幕永远不更新，而两侧代码各自看都对。
 */
/** 原生侧送来的是已序列化的 { kind, payload }。 */
function forwardFrame(frame: string): void {
  let parsed: unknown

  try {
    parsed = JSON.parse(frame)
  } catch (cause) {
    console.error('原生事件不是 JSON', cause)
    return
  }

  if (!isRecord(parsed) || typeof parsed['kind'] !== 'string') {
    console.error('原生事件的形状不对', parsed)
    return
  }

  send(`poietica:event:${parsed['kind']}`, parsed['payload'] ?? null)
}

/** 交给系统浏览器的只有三种协议；判断走 URL 解析而不是 startsWith，'https://example.com.attacker.com' 骗不了它。 */
async function openExternal(url: string): Promise<void> {
  let scheme: string

  try {
    scheme = new URL(url).protocol
  } catch {
    console.warn('拒绝打开无法解析的地址', url)
    return
  }

  if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'mailto:') {
    console.warn('拒绝打开非 web 地址', url)
    return
  }

  await shell.openExternal(url)
}

/**
 * 图标正本所在的目录：打包产物是 resources/，开发期是 apps/desktop/build/。
 * extraResources 把 build/icon.png 与 build/icon.ico 都放在 resources 根下。
 */
function iconPath(name: 'icon.png' | 'icon.ico'): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'build', name)
}

/*
 * 窗口衬底的两份抄本。正本是 packages/design-system/src/tokens/palette.css 的
 * --ui-palette-neutral-75 / --ui-palette-dark-850，逐通道相等由架构闸门核对
 * （tools/architecture/charters.ts 的 themeSurfaceIsAligned）。
 */
const LIGHT_SURFACE = [243, 243, 243] as const
const DARK_SURFACE = [32, 32, 32] as const

/**
 * 按偏好落定窗口衬底与原生主题，交回此刻真正生效的那一档。
 *
 * 两件事必须一起做、且要在窗口露出来之前：只留渲染层投影时，投影要等设置加载与 React 首帧，
 * 中间露出的是创建值 —— 深色偏好配浅色创建值，启动那一瞬就是浅色底。
 */
function createWindowSurface(win: BrowserWindow, preference: ThemePreference): 'light' | 'dark' {
  nativeTheme.themeSource = preference

  const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const [red, green, blue] = resolved === 'dark' ? DARK_SURFACE : LIGHT_SURFACE

  win.setBackgroundColor(cssColor([red, green, blue]))

  return resolved
}

/**
 * 启动时那一档主题偏好。
 *
 * 渲染层把它持久化在 settings.json 里（settings 包的 theme 一格），而窗口要在渲染层
 * 起来**之前**就画出正确的衬底 —— 否则深色偏好会先露一瞬浅色创建值，看上去像白闪。
 * 读失败就退回 'system'：那是没有设置时的语义，不是错误。
 */
async function startupThemePreference(): Promise<ThemePreference> {
  const settings = await readPersistedSettings()
  const theme = settings?.['theme']

  if (theme === 'light' || theme === 'dark' || theme === 'system') {
    return theme
  }

  return 'system'
}

/**
 * 落盘那一格应用设置（settings.json 的 `settings` 键），读不出来就是 undefined。
 *
 * 形状是 `{ settings: { … } }`，不是平的。正本是 apps/desktop/native/src/settings/storage.rs
 * 的 SETTINGS_KEY = "settings" —— 整份文档是「键 → 各家设置」的映射，应用设置只是其中
 * 一个键。少剥这一层就永远读到 undefined，两边都会退回默认值。
 *
 * 主进程要在**渲染层起来之前**拿到两格：窗口衬底（theme）与日志闸门（logging.level）。
 * 它们同读一份文件，所以共用这一处解析。
 */
async function readPersistedSettings(): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(text)
    const settings = isRecord(parsed) ? parsed['settings'] : undefined

    return isRecord(settings) ? settings : undefined
  } catch {
    /* 首次启动还没有这个文件；两格都按默认走。 */
    return undefined
  }
}

/**
 * 衬底的线上记法。
 *
 * BrowserWindow 的创建值与 setBackgroundColor 收同一种字符串，而两档衬底的正本是
 * 上面那两个 RGB 常量 —— 这里做唯一的转换，别处不再写第二份十六进制字面值。
 */
function cssColor([red, green, blue]: readonly [number, number, number]): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function createWindow(preference: ThemePreference): BrowserWindow {
  const win = new BrowserWindow({
    // name + windowStatePersistence：位置、尺寸、最大化由 Electron 自己存，不用再写一份 window-state.ts。
    name: MAIN_WINDOW,
    windowStatePersistence: true,
    frame: false,
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    /*
     * 创建值取偏好那一档的衬底。窗口是 show:false 建的，露出来之前 createWindowSurface
     * 还会再落定一次；这一行管的是「露出来那一刻」——留着浅色创建值，深色偏好启动
     * 就会闪一下白。
     */
    backgroundColor: cssColor(preference === 'dark' ? DARK_SURFACE : LIGHT_SURFACE),
    icon: iconPath('icon.ico'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  // 偏好已经读过（startupThemePreference），这里落定原生主题与衬底。
  createWindowSurface(win, preference)

  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url)

    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    // 主界面自己不导航；外链一律交给系统浏览器。
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      void openExternal(url)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']

  if (devUrl === undefined || devUrl.length === 0) {
    void win.loadFile(join(__dirname, '../dist/index.html'))
  } else {
    void win.loadURL(devUrl)
  }

  // 主界面没有露面就是没有可用界面：渲染层 8 秒还没 present 就直接显示，日志里留一句。
  const watchdog = setTimeout(() => {
    if (!quitting && !win.isDestroyed() && !win.isVisible()) {
      console.warn('渲染层未在 8 秒内 present，直接显示窗口')
      activate(win)
    }
  }, 8000)

  win.on('closed', () => {
    clearTimeout(watchdog)
    mainWindow = null
  })

  // 界面上那个 × 是渲染层自己的按钮，它调 host.close() 走 app.quit()；系统关窗（Alt+F4）同样先问渲染层。
  win.on('close', (event) => {
    if (quitting) {
      return
    }

    event.preventDefault()
    send('poietica:close-requested', null)
  })

  win.on('resize', () => {
    // 面板矩形是渲染层上报的 CSS 像素，窗口尺寸变了只需按同一个矩形重摆一次。
    browserHost?.relayout()
  })

  win.on('maximize', () => {
    send('poietica:window-maximized', true)
  })

  win.on('unmaximize', () => {
    send('poietica:window-maximized', false)
  })

  return win
}

function installTray(win: BrowserWindow): void {
  /*
   * 托盘图标给 .ico，不给缩过的 PNG：.ico 里是 16/24/32/48/64/256 各一档，由 Windows
   * 按自己的 DPI 挑那一档（100% 取 16、200% 取 32），一位像素都不用重采样。
   * 换成 PNG 就只剩一次缩放 —— 512 的满幅绿方块缩到 16，白圈只有一像素宽，必糊。
   */
  tray = new Tray(iconPath('icon.ico'))
  tray.setToolTip('Poietica')

  /*
   * 只留两项：打开与退出。
   *
   * 中间那几项（显示/隐藏/强制退出）都是「窗口本来就能做的事」在托盘里再抄一遍，
   * 而托盘菜单的读者是「窗口不在眼前时」的人 —— 他只需要一个把它叫回来的入口，
   * 与一个真的结束它的入口。
   */
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Poietica', click: () => activate(win) },
      {
        label: '退出',
        click: () => {
          // 先把窗口叫出来：确认对话框画在一个隐藏的窗口里等于没有对话框。
          activate(win)
          send('poietica:termination-requested', null)
        },
      },
    ]),
  )
  tray.on('click', () => {
    if (win.isVisible() && win.isFocused()) {
      win.hide()
    } else {
      activate(win)
    }
  })
}

async function shutdownNative(): Promise<void> {
  const host = nativeHost

  nativeHost = null

  if (host === null) {
    return
  }

  try {
    await host.shutdown()
  } catch (cause) {
    console.error('原生侧没有干净退出', cause)
  }
}

/** Electron 把 IPC 的异常压成一句 message，成功那边的形状只能靠返回值得知。 */
function failure(cause: unknown): Reply {
  if (typeof cause === 'object' && cause !== null && 'problem' in cause) {
    return { ok: false, problem: cause.problem }
  }

  return refusal(cause instanceof Error ? cause.message : String(cause))
}

/** 只有主窗口顶层帧能调宿主：外站视图、iframe 与别的 WebContents 一律在门口挡住。 */
function fromMainWindow(event: IpcMainInvokeEvent, win: BrowserWindow): boolean {
  if (event.sender !== win.webContents) {
    return false
  }

  const frame = event.senderFrame

  return frame !== null && frame.parent === null
}

interface PickOptions {
  multiple: boolean
  filters: { name: string; extensions: string[] }[]
}

interface PickSaveOptions {
  defaultPath: string
  filters: { name: string; extensions: string[] }[]
}

function isPickSaveOptions(value: unknown): value is PickSaveOptions {
  if (!isRecord(value) || typeof value['defaultPath'] !== 'string') {
    return false
  }

  return isPickOptions({ multiple: true, filters: value['filters'] })
}

function isPickOptions(value: unknown): value is PickOptions {
  if (
    !isRecord(value) ||
    typeof value['multiple'] !== 'boolean' ||
    !Array.isArray(value['filters'])
  ) {
    return false
  }

  return value['filters'].every(
    (filter) =>
      isRecord(filter) &&
      typeof filter['name'] === 'string' &&
      Array.isArray(filter['extensions']) &&
      filter['extensions'].every((extension) => typeof extension === 'string'),
  )
}

function isNotificationRequest(value: unknown): value is { title: string; body: string } {
  if (!isRecord(value)) {
    return false
  }

  return typeof value['title'] === 'string' && typeof value['body'] === 'string'
}

function isSurfaceColor(value: unknown): value is readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    return false
  }

  return value.every(
    (part) => typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= 255,
  )
}

function isExportRequest(value: unknown): value is { content: string; format: 'csv' | 'markdown' } {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value['content'] === 'string' &&
    (value['format'] === 'csv' || value['format'] === 'markdown')
  )
}

/**
 * 宿主自己的两张命令表：更新（update.ts）与存储（storage.ts）。
 *
 * 两者都是宿主能力 —— electron-updater 与 Chromium 的缓存、分区存储，原生侧一样没有；
 * 写成 Rust 命令只会多出几个永远报错的空壳。认不出就交回 null，由原生那条路接手。
 */
async function runHostCommands(command: unknown, args: unknown): Promise<Reply | null> {
  if (updateCommands.handles(command)) {
    try {
      return ok(await updateCommands.run(command as string, args))
    } catch (cause) {
      return failure(cause)
    }
  }

  if (storageCommands?.handles(command) === true) {
    try {
      return ok(await storageCommands.run(command as string, args))
    } catch (cause) {
      return failure(cause)
    }
  }

  return null
}

function installHandlers(win: BrowserWindow): void {
  ipcMain.handle(
    'poietica:invoke',
    async (event, command: unknown, args: unknown): Promise<Reply> => {
      if (!fromMainWindow(event, win)) {
        return refusal(DENIED)
      }

      const local =
        browserHost === null
          ? { handled: false as const }
          : applyBrowserCommand(browserHost, typeof command === 'string' ? command : '', args)

      if (local.handled) {
        return ok(local.value)
      }

      /* 更新与存储都是宿主自己的能力：认得出就在这里答，认不出才转原生。 */
      const hosted = await runHostCommands(command, args)

      if (hosted !== null) {
        return hosted
      }

      const host = router

      if (host === null) {
        return refusal('poietica: hostFailed — 原生宿主还没起来')
      }

      /*
       * 等启动跑完再放行。
       *
       * 窗口在 `native.start()` 之前就建好了，渲染层的首帧会**同时**发出十几条读
       * （设置、控件表、能力清单）。原生侧在这条命令落进去的时候可能还没把运行时接好：
       * 那些读于是撞上一个「内部还没准备好」，被折成 agentRejected，界面上就是首启那一次
       * 「agent 连接失败」—— 一次纯粹由我们自己的启动顺序造成的假故障。
       *
       * 命令本来就是并发允许的，缺的只是「别早于 start」。这里等的是一次已经开始的启动，
       * 不是加一道闸：start 失败时把那次失败如实交回，不吞。
       */
      try {
        await nativeReady

        return ok(await host.invoke(command, args))
      } catch (cause) {
        return failure(cause)
      }
    },
  )

  ipcMain.handle('poietica:window', (event, action: unknown): Reply => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    switch (action) {
      case 'minimize':
        win.minimize()

        return ok(null)

      case 'toggleMaximize':
        if (win.isMaximized()) {
          win.unmaximize()
        } else {
          win.maximize()
        }

        return ok(null)

      /* 初值那一格：Electron 只在变化时推事件，没有「此刻是不是最大化」的推送快照。 */
      case 'isMaximized':
        return ok(win.isMaximized())

      case 'close':
        // 标题栏的关闭按钮：走退出屏障，别绕过它。
        app.quit()

        return ok(null)

      case 'openDevtools':
        /*
         * 必须 detach：不带 mode 时 Electron 按「上次用过的停靠位」开，而主窗口是
         * frame: false 的，工具一停靠就直接顶掉界面。detach 是独立窗口，也拖不回去。
         */
        win.webContents.openDevTools({ mode: 'detach' })

        return ok(null)

      case 'present':
        activate(win)

        return ok(null)

      default:
        return refusal('poietica: requestInvalid — 未知的窗口动作')
    }
  })

  ipcMain.handle('poietica:open-external', async (event, url: unknown): Promise<Reply> => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    if (typeof url !== 'string' || url.length === 0) {
      return refusal('poietica: requestInvalid — 打开的地址必须是非空字符串')
    }

    await openExternal(url)

    return ok(null)
  })

  ipcMain.handle('poietica:pick-root', async (event): Promise<Reply> => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    const picked = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    })

    return ok(picked.canceled ? null : (picked.filePaths[0] ?? null))
  })

  ipcMain.handle('poietica:pick-paths', async (event, options: unknown): Promise<Reply> => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    if (!isPickOptions(options)) {
      return refusal(
        'poietica: requestInvalid — 挑文件要说明能不能多选，过滤器要写成 { name, extensions[] }',
      )
    }

    const picked = await dialog.showOpenDialog(win, {
      properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: options.filters.map((filter) => ({
        name: filter.name,
        extensions: [...filter.extensions],
      })),
    })

    // 取消是 null 而不是空数组：调用方要分得开「没选」与「选了零个」。
    return ok(picked.canceled ? null : picked.filePaths)
  })

  ipcMain.handle('poietica:home-directory', (event): Reply => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    return ok(app.getPath('home'))
  })

  ipcMain.handle('poietica:app-version', (event): Reply => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    // 版本号的唯一产地：打包配置写进 app 的那一版。渲染层另写一份就是第二个真相。
    return ok(app.getVersion())
  })

  /*
   * 长任务跑完时的一声：只有窗口不在前台才发 —— 人正看着屏幕的时候弹一条系统通知，
   * 是把「已经看见的事」再说一遍。前台判定归宿主（Electron 自己知道窗口有没有焦点）。
   */
  ipcMain.handle('poietica:notify', (event, request: unknown): Reply => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    if (!isNotificationRequest(request)) {
      return refusal('poietica: requestInvalid — 通知要有 title 与 body 两个字符串')
    }

    if (!win.isFocused() && Notification.isSupported()) {
      new Notification({
        title: request.title,
        body: request.body,
        icon: iconPath('icon.png'),
      }).show()
    }

    return ok(null)
  })

  /*
   * 日志闸门。渲染层是设置的持有者，主进程只接它的结论 —— 与主题同一分工：
   * 原生侧那一份由 settings_set 自己套用，这里套用的是 electron-log 这一份。
   */
  ipcMain.handle('poietica:set-log-level', (event, level: unknown): Reply => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    if (typeof level !== 'string' || level.length === 0) {
      return refusal('poietica: requestInvalid — 日志级别必须是非空字符串')
    }

    setLogLevel(level)

    return ok(null)
  })

  ipcMain.handle('poietica:set-surface', (event, color: unknown): Reply => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    if (!isSurfaceColor(color)) {
      return refusal('poietica: requestInvalid — 底色是三个 0-255 的整数')
    }

    win.setBackgroundColor(`rgb(${color[0]}, ${color[1]}, ${color[2]})`)

    return ok(null)
  })

  ipcMain.handle('poietica:pick-save-path', async (event, options: unknown): Promise<Reply> => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    if (!isPickSaveOptions(options)) {
      return refusal('poietica: requestInvalid — 保存对话框要说明默认文件名与过滤器')
    }

    const picked = await dialog.showSaveDialog(win, {
      defaultPath: options.defaultPath,
      filters: options.filters.map((filter) => ({
        name: filter.name,
        extensions: [...filter.extensions],
      })),
    })

    // 取消是 null 而不是空串：调用方要分得开「没选」与「选了空路径」。
    return ok(picked.canceled || !picked.filePath ? null : picked.filePath)
  })

  ipcMain.handle('poietica:save-export', async (event, request: unknown): Promise<Reply> => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    if (!isExportRequest(request)) {
      return refusal('poietica: requestInvalid — 导出请求要有 content 与 csv/markdown 格式')
    }

    const csv = request.format === 'csv'
    const picked = await dialog.showSaveDialog(win, {
      defaultPath: csv ? 'export.csv' : 'export.md',
      filters: csv
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'Markdown', extensions: ['md'] }],
    })

    if (picked.canceled || picked.filePath === undefined || picked.filePath.length === 0) {
      return ok(false)
    }

    await writeFile(picked.filePath, request.content, 'utf8')

    return ok(true)
  })

  ipcMain.handle('poietica:set-theme', (event, preference: unknown): Reply => {
    if (!fromMainWindow(event, win)) {
      return refusal(DENIED)
    }

    if (preference !== 'light' && preference !== 'dark' && preference !== 'system') {
      return refusal('poietica: requestInvalid — 主题偏好只有 light/dark/system')
    }

    // 跟随系统时此刻到底是哪一档，只有宿主答得出来；渲染层只消费返回值。
    return ok(createWindowSurface(win, preference))
  })
}

/**
 * 应用名与 userData 落点。必须在**模块顶层**钉住，早于 `whenReady` 与任何 `getPath`。
 *
 * 两件事要分开做，`setName` 单独不够：它只改 `app.getName()`，而 `userData` 在
 * Electron 更早的启动阶段就已由 package.json 的 name 定下（实测 `setName` 之后
 * 仍是 `%APPDATA%\Electron`）。
 *
 * 不钉的后果：数据根跟着包名跑（`%APPDATA%\@poietica\desktop`），换一次包名就等于
 * 换一个数据根，对话与设置全留在旧目录里 —— 表现为「连不上 agent」。
 * 这个名字与 electron-builder.yml 的 productName 是同一个。
 *
 * **开发构建另立一个目录**：数据根就是 userData（正本 docs/architecture/data-layout.md），
 * 两者共用会让开发版与安装版同时写同一份账本、同一个 agent 受控 home。
 *
 * **内核那摊子再往下分一层**：Chromium 的缓存、代码缓存与分区存储归 sessionData，
 * 落在 <数据根>/session（./session-directory.ts）。数据根里只剩我们的数据，
 * 「这个应用占了多大地方」「清理该清哪一处」才有单一答案。
 */
const APPLICATION_NAME = 'Poietica'

const DATA_ROOT = join(
  app.getPath('appData'),
  app.isPackaged ? APPLICATION_NAME : `${APPLICATION_NAME} Dev`,
)

app.setName(APPLICATION_NAME)
app.setPath('userData', DATA_ROOT)
/*
 * 日志目录也钉进数据根。
 *
 * 不钉的话 `app.getPath('logs')` 在 macOS 上是 `~/Library/Logs/Poietica` —— 数据跑到
 * 数据根外面去了，而 ADR 0031 与 data-layout.md 说的是「应用数据只在 userData 一处」。
 * Windows/Linux 恰好落在 userData 下面，所以这个洞只在 macOS 上露出来：同一份代码两种布局。
 */
app.setAppLogsPath(join(DATA_ROOT, 'logs'))
/* 内核那一摊也住在数据根下面的一层：Chromium 自己会在 <数据根>/session 里铺它要的一切，
   所以这里只报落点，不预先建目录、不搬任何东西。 */
app.setPath('sessionData', join(DATA_ROOT, SESSION_DIRECTORY))

/*
 * Windows 的 AppUserModelID。
 *
 * 任务栏按键按它归档，**图标也按它取**：按键画的是该身份对应快捷方式的那张图，
 * 窗口自己的 WM_SETICON 图标在这里不作数 —— 这就是「窗口图标是对的、任务栏却是
 * electron.exe 那张原子图」的原因。
 *
 * 开发构建必须另立一个身份。身份与图标在系统里按 AUMID 缓存一份，开发版
 * （electron.exe）与安装版共用 com.poietica.Poietica 时，谁先跑谁把那张图标写进缓存，
 * 安装版之后按同一个 AUMID 取到的还是它 —— 换掉 exe 内嵌的图标也不动，因为取的不是它。
 * 数据根已按同一理由分了家（DATA_ROOT），身份跟着分，别共用一个。
 *
 * 安装版这个字符串必须与 electron-builder.yml 的 appId 一致：打包器按它写进快捷方式，
 * 两边不一致会把同一个应用劈成两个身份。
 */
app.setAppUserModelId(app.isPackaged ? 'com.poietica.Poietica' : 'com.poietica.Poietica.Dev')

/**
 * 会话能力到存储那一格的两个动作。
 *
 * clearData 的 'cache' 一档就是 Chromium 的「缓存与文件」—— 实测（Electron 44.5.1）
 * 灌进 8MB 再清，HTTP 磁盘缓存只剩索引。
 */
function storagePort(target: Session): StorageSessionPort {
  return {
    clearKernelCache: () => target.clearData({ dataTypes: ['cache'] }),
    clearSiteData: () => target.clearStorageData(),
  }
}

async function main(): Promise<void> {
  /* 先把数据根建出来再开窗：窗口衬底要在渲染层起来之前读它下面的 settings.json。 */
  await prepareDataRoot(DATA_ROOT)

  /*
   * 日志出口要在**建窗之前**装上：它之后发生的每一次 console 异常、渲染层崩溃与
   * 进程级未捕获异常才会留在盘上。electron-log 自己解析 app.getPath('logs')，
   * 而那个目录就在数据根下面（是数据根，不是默认的 %APPDATA%\electron）。
   */
  const persisted = await readPersistedSettings()
  const logging = persisted?.['logging']

  installLogging(isRecord(logging) ? logging['level'] : undefined)

  const dataRoot = DATA_ROOT
  const win = createWindow(await startupThemePreference())

  mainWindow = win

  const bundledDirectory = app.isPackaged
    ? join(process.resourcesPath, 'agent')
    : join(app.getAppPath(), 'resources', 'agent')

  /*
   * 图片的字节住在原生侧的内存注册表里（进门不落盘，发送那一刻才搬进附件根），
   * 所以这条协议问的是原生，不是磁盘 —— 见 asset-protocol.ts 的头注释。
   * 处理器收的是「怎么取」而不是数据根：原生那侧换成什么取法，这里都不用改。
   *
   * 一次请求一取：没有按 (session, hash) 缓存。上限是 crates/asset/src/identity.rs 的
   * MAX_ASSET_BYTES（32 MiB，base64 后约 43 MiB），而 cache-control 是 immutable，
   * 所以同一条地址浏览器自己只来取一次；再加一层缓存只是多一份要与 asset_remove 对齐的
   * 生命周期。真要加，加在这里，别加到协议处理器里。
   */
  protocol.handle(
    'poietica-asset',
    createAssetProtocolHandler({
      async read(sessionToken, assetToken, range) {
        const host = router

        if (host === null) {
          return null
        }

        const read = (await host.invoke('asset_read', {
          request: {
            sessionToken,
            assetToken,
            ...(range === undefined ? {} : { offset: range.start, length: range.length }),
          },
        })) as { contentType: string; base64: string; byteLength: number; totalLength: number }

        return {
          contentType: read.contentType,
          bytes: Buffer.from(read.base64, 'base64'),
          totalLength: read.totalLength,
        }
      },
    }),
  )

  /*
   * 外站视图与主界面共用一个持久会话，但权限一项都不给：要放行哪一种，将来在这里单独开口。
   *
   * 两半都要装：request 管的是「现在能不能用」，check 管的是同步查询
   * （navigator.permissions.query、Permissions-Policy 的判定）。只装一半，页面同步问到的
   * 答案与真要用的结果不一致。
   */
  const browserSession = session.fromPartition(BROWSER_PARTITION)

  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  browserSession.setPermissionCheckHandler(() => false)

  /* 存储那一格要清的两个会话。适配写在这里：storage.ts 只认那两条动作，不认识 electron。 */
  storageCommands = createStorageCommands({
    root: dataRoot,
    sessions: {
      app: storagePort(session.defaultSession),
      browser: storagePort(session.fromPartition(BROWSER_PARTITION)),
    },
  })

  /* 标签面每一次变化都同时喂两条线：渲染层（屏幕）与 agent（relay）。 */
  const browserState = (): void => {
    presentBrowserState()
    browserRelay?.publish(browserHost?.state() ?? null)
  }

  browserHost = createBrowserHost(win, browserState, {
    onElementPicked: (picked) => {
      // 事件名与生成物的 events.browserElementPicked 一致。
      send('poietica:event:browser-element-picked', picked)
    },
  })

  /*
   * agent 那条线：把面板里的标签当成一台现成的浏览器端出去（./browser/relay.ts）。
   *
   * onDriven 是「agent 正要动浏览器」的唯一信号：relay 服务端由 omp 自己的浏览器前奏
   * 按需拉起，所以它活着就等于 agent 要用，而不是应用启动了。面板据此自己展开 ——
   * 用户不必先去点一下浏览器那一格，AI 动的时候看得见。
   */
  browserRelay = createBrowserRelay(browserHost, {
    url: DEFAULT_RELAY_URL,
    onDriven: () => {
      send('poietica:event:browser-driven', null)
    },
  })
  browserRelay.start()

  const native = loadNative()

  nativeHost = native
  // attach 必须在 start 之前：start 会恢复现场，那时发出来的事件要有接收者。
  native.attach({ emit: forwardFrame })

  router = createRouter({
    native: { invoke: (command, argsJson) => native.invoke(command, argsJson) },
  })

  installHandlers(win)
  installTray(win)

  // 路径只能由主进程算：原生侧不猜目录，也不读环境变量。
  try {
    await native.start({
      dataRoot,
      homeDirectory: app.getPath('home'),
      bundledDirectory,
      // 日志目录由宿主定：Electron 的 app.getPath('logs') 是它的官方产地，主进程与原生侧写同一处。
      logDirectory: app.getPath('logs'),
    })
  } finally {
    /*
     * 失败也要放行：那道门等的是「启动跑完了」，不是「启动成功了」。
     * 卡在这儿不放，会把一次可诊断的启动失败变成界面永远转圈。
     */
    settleNativeReady()
  }

  app.on('window-all-closed', () => {
    app.quit()
  })

  /*
   * 退出屏障：原生侧还没关干净就不许真退，第二次 before-quit 才放行。
   *
   * 例外只有一个 —— 更新装好之后 electron-updater 先发 before-quit-for-update 再
   * app.quit()，那个 quit 必须立刻放行：拦下来只把窗口关掉，安装器已经起来等着接管
   * 文件，等于永远装不上。
   *
   * 事件发在 electron 的 autoUpdater 上（electron-updater 就是这么发的），不在 app 上。
   */
  let installingUpdate = false

  autoUpdater.on('before-quit-for-update', () => {
    installingUpdate = true
  })

  app.on('before-quit', (event) => {
    if (quitting || installingUpdate) {
      return
    }

    event.preventDefault()
    quitting = true
    browserHost?.dispose()

    void shutdownNative().finally(() => {
      app.quit()
    })
  })
}
