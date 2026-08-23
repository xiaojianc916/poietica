import { commands, events } from '@poietica/ipc/generated/ipc-bindings'
import type { Window } from '@tauri-apps/api/window'

export interface MainWindowController {
  /** 呈现窗口。窗口以 visible: false 创建，呈现时机由渲染层决定。 */
  present(): Promise<void>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  /** 最大化态的变化。窗口是唯一真相，这里只收它播报的翻转。 */
  onMaximizedChanged(handler: (isMaximized: boolean) => void): Promise<() => void>
  /** 窗口层衬底色：拖动与缩放时新扩展出来的区域填的是它，不是 webview 内容。 */
  setBackingColor(cssColor: string): Promise<void>
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

/* Tauri 的窗口模块在 webview 之外不可用，所以它留在静态依赖图之外；解析一次，整个进程复用。 */
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

/*
 * Window.setBackgroundColor 只收数字通道，而衬底色的真相是一条 CSS 颜色。
 * getComputedStyle 取到的 <color> 由 CSSOM 规定序列化成 rgb()/rgba()，所以只认
 * 这一种形状；认不出就抛 —— 静默填一个颜色等于在原生侧再造一份真相。
 */
const CSS_RGB = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/

function toNativeColor(cssColor: string): [number, number, number] {
  const channels = CSS_RGB.exec(cssColor.trim())

  if (channels === null) {
    throw new Error('Unsupported window backing colour: ' + cssColor)
  }

  return [Number(channels[1]), Number(channels[2]), Number(channels[3])]
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

    async onMaximizedChanged(handler) {
      return events.windowMaximized.listen((event) => {
        handler(event.payload.isMaximized)
      })
    },

    async setBackingColor(cssColor) {
      const window = await getMainWindow()

      await window.setBackgroundColor(toNativeColor(cssColor))
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
