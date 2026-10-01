/*
 * 应用组合根：窗口、托盘、主题、退出屏障，以及渲染层到原生宿主的那一跳。
 *
 * 渲染层永远拿不到 require/ipcRenderer/fs：能力只从 preload.ts 的桥进来，
 * 命令落到 ipc-router.ts（转原生）、browser/host.ts（标签是宿主自己的状态）或
 * update.ts（更新同样是宿主的能力）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  session,
  shell,
  Tray,
} from 'electron'

import { createAssetProtocolHandler } from './asset-protocol'
import type { BrowserHost } from './browser/host'
import { applyBrowserCommand, BROWSER_PARTITION, createBrowserHost } from './browser/host'
import type { Router } from './ipc-router'
import { createRouter } from './ipc-router'
import type { NativeHost } from './native'
import { loadNative } from './native'
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

/** Windows 通知区域的标准图标边长。 */
const TRAY_ICON_SIZE = 16

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
let nativeHost: NativeHost | null = null
let router: Router | null = null
let tray: Tray | null = null
let quitting = false

/* 更新的相位活在主进程里（update.ts）；electron-updater 到第一次调用才装载。 */
const updateCommands: UpdateCommands = createUpdateCommands(loadUpdater)

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

function send(channel: string, payload: unknown): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
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

function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
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
  try {
    const text = await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(text)
    /*
     * 形状是 { settings: { theme } }，不是 { theme }。
     *
     * 正本是 apps/desktop/native/src/settings/storage.rs 的 SETTINGS_KEY = "settings" ——
     * 整份文档是「键 → 各家设置」的映射，应用设置只是其中一个键。少剥这一层就永远
     * 读到 undefined，每次都退回 'system'，于是窗口底色跟随系统主题而不是用户的偏好。
     */
    const settings = isRecord(parsed) ? parsed['settings'] : undefined
    const theme = isRecord(settings) ? settings['theme'] : undefined

    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      return theme
    }
  } catch {
    // 首次启动还没有这个文件；按系统那一档走。
  }

  return 'system'
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
    icon: iconPath(),
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
   * 托盘图标按 Windows 的通知区域尺寸给：512×512 的窗口图标缩到 16px 会糊成一团。
   * 打包产物里只带 icon.png，所以按目标尺寸重采样 —— 与其多发一张专门的小图，
   * 不如让同一张正本缩出托盘要的那一档。
   */
  const icon = nativeImage
    .createFromPath(iconPath())
    .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: 'best' })

  tray = new Tray(icon)
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

      /* 更新与标签同类：命令名由主进程自己认，认不出才转原生。 */
      if (updateCommands.handles(command)) {
        try {
          return ok(await updateCommands.run(command as string, args))
        } catch (cause) {
          return failure(cause)
        }
      }

      const host = router

      if (host === null) {
        return refusal('poietica: hostFailed — 原生宿主还没起来')
      }

      try {
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
 * 换一个数据根，用户的对话与设置全留在旧目录里 —— 表现为「连不上 agent」。
 * 这个名字与 electron-builder.yml 的 productName 是同一个。
 */
const APPLICATION_NAME = 'Poietica'

app.setName(APPLICATION_NAME)
app.setPath('userData', join(app.getPath('appData'), APPLICATION_NAME))

/*
 * Windows 的 AppUserModelID。
 *
 * 任务管理器与开始菜单按它把进程归到一个应用名下，并按它去取图标与显示名 ——
 * 不设的话，未打包时它们只认得 electron.exe 自带的身份，于是那一栏写着「Electron」。
 * 这个字符串必须与 electron-builder.yml 的 appId 一致：安装版由打包器写进快捷方式，
 * 两边不一致会把同一个应用劈成两个身份。
 */
app.setAppUserModelId('com.poietica.Poietica')

/**
 * 数据根。两条规则各有硬约束（正本 docs/architecture/data-layout.md）：
 *
 * - **安装版**：放在程序旁边。用户在安装器上只做一次选择，那一次选择同时回答
 *   「程序装到哪」与「数据存到哪」；判据是可执行文件在哪，所以安装期不需要写下
 *   任何声明，用户把整个目录搬到别的盘，数据跟着走。
 * - **开发构建**：exe 在 node_modules 里，往那儿写用户数据会被依赖重装抹掉，
 *   所以交给 Electron 的 userData（平台目录）。
 *
 * 两者分开，开发版与安装版不会同时打开同一个 WAL 库，也不会互相覆盖凭据。
 */
function resolveDataRoot(): string {
  if (!app.isPackaged) {
    return app.getPath('userData')
  }

  return dirname(app.getPath('exe'))
}
async function main(): Promise<void> {
  const win = createWindow(await startupThemePreference())

  mainWindow = win

  const dataRoot = resolveDataRoot()
  const bundledDirectory = app.isPackaged
    ? join(process.resourcesPath, 'agent')
    : join(app.getAppPath(), 'resources', 'agent')

  await mkdir(dataRoot, { recursive: true })
  protocol.handle('poietica-asset', createAssetProtocolHandler(dataRoot))

  // 外站视图与主界面共用一个持久会话，但权限一项都不给：要放行哪一种，将来在这里单独开口。
  session
    .fromPartition(BROWSER_PARTITION)
    .setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })

  browserHost = createBrowserHost(win, presentBrowserState, {
    onElementPicked: (picked) => {
      // 事件名与生成物的 events.browserElementPicked 一致。
      send('poietica:event:browser-element-picked', picked)
    },
  })

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
  await native.start({
    dataRoot,
    homeDirectory: app.getPath('home'),
    bundledDirectory,
  })

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
