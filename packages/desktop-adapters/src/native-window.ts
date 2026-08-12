import { commands } from '@poietica/ipc/generated/ipc-bindings'
import type { Window } from '@tauri-apps/api/window'

export interface MainWindowController {
  /** 呈现窗口。窗口以 visible: false 创建，呈现时机由渲染层决定。 */
  present(): Promise<void>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  /** 布局状态机的最小化护栏问的就是它：页面侧信号与宿主最小化状态脱钩。 */
  isMinimized(): Promise<boolean>
  onResized(handler: () => void): Promise<() => void>
  openDeveloperTools(): Promise<void>
  close(): Promise<void>
  forceClose(): void
  onCloseRequested(handler: () => void): Promise<() => void>
  /** 托盘"退出程序"。与关闭按钮汇入同一条终止管线。 */
  onTerminationRequested(handler: () => void): Promise<() => void>
  setTitle(title: string): Promise<void>
}

const MAIN_WINDOW_LABEL = 'main'

/** 与 src-tauri/src/bootstrap/tray.rs 的 TERMINATION_REQUESTED_EVENT 对应。 */
const TERMINATION_REQUESTED_EVENT = 'poietica://termination-requested'

let mainWindow: Promise<Window> | undefined

/*
 * 一次动态 import，整个进程复用。
 *
 * Tauri 的窗口模块在 webview 之外不可用，所以它必须留在静态依赖图之外；但此前
 * 每一个方法各自 await import 一次，把一组同步能力全部变成了 per-call 的解析
 * 往返——use-window-chrome.ts 里那套请求版本号就是为此存在的。
 */
function getMainWindow(): Promise<Window> {
  mainWindow ??= import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const current = getCurrentWindow()

    if (current.label !== MAIN_WINDOW_LABEL) {
      throw new Error('The desktop runtime is bound to the "main" window only.')
    }

    return current
  })

  return mainWindow
}

async function insideTauri(): Promise<boolean> {
  const { isTauri } = await import('@tauri-apps/api/core')

  return isTauri()
}

export function createMainWindowController(): MainWindowController {
  return {
    async present() {
      const window = await getMainWindow()

      await window.show()
      await window.setFocus()
    },

    async minimize() {
      const window = await getMainWindow()

      await window.minimize()
    },

    async toggleMaximize() {
      const window = await getMainWindow()

      await window.toggleMaximize()
    },

    async isMaximized() {
      const window = await getMainWindow()

      return window.isMaximized()
    },

    async isMinimized() {
      const window = await getMainWindow()

      return window.isMinimized()
    },

    async onResized(handler) {
      const window = await getMainWindow()

      return window.onResized(() => {
        handler()
      })
    },

    async close() {
      const window = await getMainWindow()

      await window.close()
    },

    forceClose() {
      /*
       * 终止是有意的 fire-and-forget：渲染层可能在任何应答返回之前就消失了。
       */
      void getMainWindow()
        .then((window) => window.destroy())
        .catch(() => {
          // 进程终止失败时没有可用的渲染层补救界面，不要弹一个内部重试框。
        })
    },

    async onCloseRequested(handler) {
      if (!(await insideTauri())) {
        return () => {}
      }

      const window = await getMainWindow()

      return window.onCloseRequested((event) => {
        event.preventDefault()
        handler()
      })
    },

    async onTerminationRequested(handler) {
      if (!(await insideTauri())) {
        return () => {}
      }

      const { listen } = await import('@tauri-apps/api/event')

      return listen(TERMINATION_REQUESTED_EVENT, () => {
        handler()
      })
    },

    async setTitle(title) {
      const window = await getMainWindow()

      await window.setTitle(title)
    },

    // devtools 是唯一没有 JavaScript 对应物的窗口操作。命令名与参数都由生成绑定给出。
    openDeveloperTools: () => commands.windowOpenDevtools(MAIN_WINDOW_LABEL),
  }
}
