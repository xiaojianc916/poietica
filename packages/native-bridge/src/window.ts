import type { ThemePreference } from '@poietica/contract'
import type { ResolvedTheme } from '@poietica/contract/browser'
import { hostBridge } from './host-bridge'

export type WindowSurfaceColor = readonly [red: number, green: number, blue: number]

export interface MainWindowController {
  present(): Promise<void>
  setSurfaceColor(color: WindowSurfaceColor): Promise<void>
  /** 日志闸门：改一次就重开一次，不必重启应用。 */
  setLogLevel(level: string): Promise<void>
  /** 长任务跑完时的一声；窗口在前台时宿主什么也不做。 */
  notify(request: { readonly title: string; readonly body: string }): Promise<void>
  /** 按偏好落定宿主主题，交回宿主解析出的那一档（跟随系统时就是系统此刻那一档）。 */
  setTheme(preference: ThemePreference): Promise<ResolvedTheme>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizedChanged(handler: (isMaximized: boolean) => void): Promise<() => void>
  openDeveloperTools(): Promise<void>
  quit(): Promise<void>
  onCloseRequested(handler: () => void): Promise<() => void>
  onTerminationRequested(handler: () => void): Promise<() => void>
}

/*
 * 窗口与托盘面。窗口是宿主的一等对象（Electron 的 BrowserWindow），所以这一层不经过
 * 原生命令，只调 preload 装好的 window.poietica.host —— 那些方法就是主进程的命令表。
 *
 * on* 那几个把 preload 的同步订阅包成 Promise：调用方（React 的 effect）按异步清理写，
 * 统一成一种写法比让每一处自己分辨同步异步更不容易漏掉卸载。
 */
export function createMainWindowController(): MainWindowController {
  const host = hostBridge().host

  return {
    present: () => host.present(),

    setSurfaceColor: (color) => host.setSurfaceColor(color),

    setLogLevel: (level) => host.setLogLevel(level),

    notify: (request) => host.notify(request),

    setTheme: (preference) => host.setTheme(preference),

    minimize: () => host.minimize(),
    toggleMaximize: () => host.toggleMaximize(),
    isMaximized: () => host.isMaximized(),

    onMaximizedChanged: (handler) => Promise.resolve(host.onMaximizedChanged(handler)),

    openDeveloperTools: () => host.openDevtools(),

    quit: () => host.close(),

    onCloseRequested: (handler) => Promise.resolve(host.onCloseRequested(handler)),

    onTerminationRequested: (handler) => Promise.resolve(host.onTerminationRequested(handler)),
  }
}
