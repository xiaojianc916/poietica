import { commands, events } from '@poietica/contract'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow, type WebviewWindow } from '@tauri-apps/api/webviewWindow'

export type WindowSurfaceColor = readonly [red: number, green: number, blue: number]

export interface MainWindowController {
  present(): Promise<void>
  setSurfaceColor(color: WindowSurfaceColor): Promise<void>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizedChanged(handler: (isMaximized: boolean) => void): Promise<() => void>
  openDeveloperTools(): Promise<void>
  quit(): Promise<void>
  onCloseRequested(handler: () => void): Promise<() => void>
  onTerminationRequested(handler: () => void): Promise<() => void>
}

const MAIN_WINDOW_LABEL = 'main'

function resolveMainWindow(): WebviewWindow | null {
  if (!isTauri()) {
    return null
  }
  const current = getCurrentWebviewWindow()
  if (current.label !== MAIN_WINDOW_LABEL) {
    throw new Error('The desktop runtime is bound to the "main" window only.')
  }
  return current
}

function requireMainWindow(mainWindow: WebviewWindow | null): WebviewWindow {
  if (mainWindow === null) {
    throw new Error('The native window API is unavailable outside Tauri.')
  }
  return mainWindow
}

export function createMainWindowController(): MainWindowController {
  const mainWindow = resolveMainWindow()

  return {
    async present() {
      const window = requireMainWindow(mainWindow)
      await window.show()
      await window.setFocus()
    },

    async setSurfaceColor([red, green, blue]) {
      requireMainWindow(mainWindow)
      await commands.windowSetSurface(red, green, blue)
    },

    minimize: () => requireMainWindow(mainWindow).minimize(),
    toggleMaximize: () => requireMainWindow(mainWindow).toggleMaximize(),
    isMaximized: () => requireMainWindow(mainWindow).isMaximized(),

    onMaximizedChanged: (handler) =>
      events.windowMaximized.listen((event) => {
        handler(event.payload.isMaximized)
      }),

    openDeveloperTools: () => commands.windowOpenDevtools(MAIN_WINDOW_LABEL),
    quit: () => commands.applicationQuit(),

    async onCloseRequested(handler) {
      if (mainWindow === null) {
        return () => {}
      }
      return await mainWindow.onCloseRequested((event) => {
        event.preventDefault()
        handler()
      })
    },

    async onTerminationRequested(handler) {
      if (mainWindow === null) {
        return () => {}
      }
      return await events.terminationRequested.listen(() => {
        handler()
      })
    },
  }
}
