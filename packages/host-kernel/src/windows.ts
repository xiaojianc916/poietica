import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { app, BrowserWindow, session, shell } from 'electron'
import { APP_ENTRY_URL } from './app-protocol'

export interface MainWindowConfig {
  readonly bounds?: { readonly x?: number; readonly y?: number; readonly width: number; readonly height: number }
  readonly maximized?: boolean
  readonly backgroundColor?: string
  /** 应用图标（绝对路径）。缺席时不传 icon，窗口退回 electron.exe 自带的原子图。 */
  readonly icon?: string
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications', 'fullscreen'])

export class WindowRegistry {
  private config: MainWindowConfig = {}
  private win: BrowserWindow | undefined
  private unresponsive = false

  constructor(
    private readonly o: {
      logger: Logger
      isPackaged: boolean
      /** 应用图标绝对路径；undefined 表示没找到，窗口退回 electron.exe 的原子图 */
      icon: string | undefined
      /** Windows 的 AppUserModelID；任务栏按键按它归档并取图标 */
      appId: string
    },
  ) {}

  /** 只能在 beforeWindow 钩子中调用：platform 恢复位置，preferences 设置底色 */
  configureMain(patch: MainWindowConfig): void {
    if (this.win !== undefined) throw new AppError(SystemErrorCode.conflict, '主窗口已创建，不能再修改初始配置')
    this.config = { ...this.config, ...patch }
  }

  main(): BrowserWindow {
    if (this.win === undefined || this.win.isDestroyed()) {
      throw new AppError(SystemErrorCode.notFound, '主窗口不存在')
    }
    return this.win
  }

  isMainResponsive(): boolean {
    return !this.unresponsive
  }

  focusMain(): void {
    if (this.win === undefined || this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    this.win.focus()
  }

  /**
   * 退出的第一步：用户点了关闭，窗口就该**立刻**从屏幕和任务栏上消失。
   * 只藏不毁 —— Core 关停期间还可能调用 owner='host' 的方法（浏览器标签、对话框服务），webContents 必须活着；
   * 真正销毁仍在 {@link destroyAll}，排在所有清理之后。
   */
  hideAll(): void {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.isVisible()) w.hide()
  }

  destroyAll(): void {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy()
  }

  createMain(p: { preload: string; rendererDevUrl: string | undefined }): BrowserWindow {
    const icon = this.config.icon ?? this.o.icon
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 600,
      ...this.config.bounds,
      show: false,
      frame: false, // 自绘标题栏（workbench 的 TitleBar + platform 贡献的窗口按钮）
      backgroundColor: this.config.backgroundColor ?? '#ffffff',
      // exactOptionalPropertyTypes：图标缺席时整条不写，别显式给 undefined。
      ...(icon === undefined ? {} : { icon }),
      webPreferences: {
        preload: p.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    })
    this.win = win
    /*
     * 任务栏按键画的是「AUMID 对应快捷方式」的那张图，窗口自己的 icon 只管窗口本体、Alt+Tab 与任务预览。
     * 在还没有可用快捷方式的机器上（开发版第一次跑就是），setAppDetails 的 appIconPath 是任务栏唯一
     * 拿得到图的地方 —— appId 必须一起给，缺了它其余几项会静默失效（Electron 文档明写）。
     */
    if (icon !== undefined) {
      try {
        win.setAppDetails({
          appId: this.o.appId,
          appIconPath: icon,
          appIconIndex: 0,
          relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
          relaunchDisplayName: this.o.isPackaged ? 'Poietica' : 'Poietica Dev',
        })
      } catch (e) {
        // 非 Windows、或系统不认这个组合：图标退化可以接受，但日志里要留一条
        this.o.logger.warn('setAppDetails failed', { error: String(e) })
      }
    }
    /* 安装版走 poietica-app://shell（P-06：file:// 没有 V8 代码缓存）；导航守卫与加载用同一个地址 */
    const appUrl = p.rendererDevUrl ?? APP_ENTRY_URL
    const isAppUrl = (url: string): boolean =>
      p.rendererDevUrl !== undefined ? url.startsWith(new URL(p.rendererDevUrl).origin) : url.split('#')[0] === appUrl
    const isExternal = (url: string): boolean => /^(https?:|mailto:)/i.test(url)

    win.once('ready-to-show', () => {
      if (this.config.maximized === true) win.maximize()
      win.show()
    })
    win.on('unresponsive', () => {
      this.unresponsive = true
      this.o.logger.warn('renderer unresponsive')
    })
    win.on('responsive', () => {
      this.unresponsive = false
    })

    const wc = win.webContents
    // 新窗口一律拒绝；外部链接交给系统浏览器
    wc.setWindowOpenHandler(({ url }) => {
      if (isExternal(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // 页面不得导航离开应用
    wc.on('will-navigate', (event, url) => {
      if (isAppUrl(url)) return
      event.preventDefault()
      if (isExternal(url)) void shell.openExternal(url)
    })
    wc.on('will-attach-webview', (event) => event.preventDefault())
    // 渲染进程崩溃：记录并在 1 秒后重新加载（RpcHub 会因为导航而换新的对端）
    wc.on('render-process-gone', (_event, details) => {
      this.o.logger.error('render process gone', { reason: details.reason, exitCode: details.exitCode })
      if (details.reason !== 'clean-exit') {
        setTimeout(() => {
          if (!win.isDestroyed()) win.reload()
        }, 1_000)
      }
    })
    // 默认会话（主窗口使用）只放行三种权限；浏览器面板使用独立分区，由 browser 功能自行设置
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission)),
    )
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

    void win.loadURL(appUrl)
    return win
  }
}
