import { pathToFileURL } from 'node:url'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { BrowserWindow, session, shell } from 'electron'

export interface MainWindowConfig {
  readonly bounds?: { readonly x?: number; readonly y?: number; readonly width: number; readonly height: number }
  readonly maximized?: boolean
  readonly backgroundColor?: string
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications', 'fullscreen'])

export class WindowRegistry {
  private config: MainWindowConfig = {}
  private win: BrowserWindow | undefined
  private unresponsive = false

  constructor(private readonly o: { logger: Logger; isPackaged: boolean }) {}

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

  destroyAll(): void {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy()
  }

  createMain(p: { preload: string; rendererFile: string; rendererDevUrl: string | undefined }): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 600,
      ...this.config.bounds,
      show: false,
      frame: false, // 自绘标题栏（workbench 的 TitleBar + platform 贡献的窗口按钮）
      backgroundColor: this.config.backgroundColor ?? '#ffffff',
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
    const appUrl = p.rendererDevUrl ?? pathToFileURL(p.rendererFile).href
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

    if (p.rendererDevUrl !== undefined) void win.loadURL(p.rendererDevUrl)
    else void win.loadFile(p.rendererFile)
    return win
  }
}
