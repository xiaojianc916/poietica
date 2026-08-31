import { commands, events } from '@poietica/contract'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'

export interface MainWindowController {
  present(): Promise<void>
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
const TERMINATION_REQUESTED_EVENT = 'poietica://termination-requested'
const mainWindow = resolveMainWindow()

function resolveMainWindow(): Window | null {
  if (!isTauri()) {
    return null
  }
  const current = getCurrentWindow()
  if (current.label !== MAIN_WINDOW_LABEL) {
    throw new Error('The desktop runtime is bound to the "main" window only.')
  }
  return current
}

function requireMainWindow(): Window {
  if (mainWindow === null) {
    throw new Error('The native window API is unavailable outside Tauri.')
  }
  return mainWindow
}

export function createMainWindowController(): MainWindowController {
  return {
    async present() {
      const window = requireMainWindow()
      await window.show()
      await window.setFocus()
    },

    minimize: () => requireMainWindow().minimize(),
    toggleMaximize: () => requireMainWindow().toggleMaximize(),
    isMaximized: () => requireMainWindow().isMaximized(),

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
      return await listen(TERMINATION_REQUESTED_EVENT, handler)
    },
  }
}
