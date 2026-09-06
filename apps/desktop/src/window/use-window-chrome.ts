import type { MainWindowController } from '@poietica/native-bridge/window'
import { useCallback, useEffect, useState } from 'react'
import { reportFailure } from '../notice/problem-presentation'
import { observeMaximizedState } from './maximized-state'

interface WindowChrome {
  readonly isMaximized: boolean
  readonly minimize: () => void
  readonly toggleMaximize: () => void
  readonly quit: () => void
}

/** Window state and actions exposed by the native window owner. */
export function useWindowChrome(
  mainWindow: MainWindowController,
  dispose: () => Promise<void>,
): WindowChrome {
  const isMaximized = useMaximizedState(mainWindow)

  const minimize = useCallback(() => {
    void mainWindow.minimize().catch((cause: unknown) => {
      reportFailure('WINDOW_MINIMIZE_UNAVAILABLE', {
        scope: 'window-chrome',
        operation: 'minimize-window',
        cause,
      })
    })
  }, [mainWindow])

  const toggleMaximize = useCallback(() => {
    void mainWindow.toggleMaximize().catch((cause: unknown) => {
      reportFailure('WINDOW_MAXIMIZE_UNAVAILABLE', {
        scope: 'window-chrome',
        operation: 'toggle-maximize-window',
        cause,
      })
    })
  }, [mainWindow])

  const quit = useCallback(() => {
    void dispose()
      .then(() => mainWindow.quit())
      .catch((cause: unknown) => {
        reportFailure('WINDOW_CLOSE_UNAVAILABLE', {
          scope: 'window-chrome',
          operation: 'quit-application',
          cause,
        })
      })
  }, [dispose, mainWindow])

  useTerminationRequests(mainWindow, quit)
  return { isMaximized, minimize, toggleMaximize, quit }
}

function useMaximizedState(mainWindow: MainWindowController): boolean {
  const [isMaximized, setMaximized] = useState(false)
  useEffect(
    () =>
      observeMaximizedState(mainWindow, setMaximized, (stage, cause) => {
        reportFailure(
          stage === 'read' ? 'WINDOW_STATE_QUERY_UNAVAILABLE' : 'WINDOW_STATE_SYNC_UNAVAILABLE',
          {
            scope: 'window-chrome',
            operation: stage === 'read' ? 'query-window-maximized' : 'watch-window-maximized',
            cause,
          },
        )
      }),
    [mainWindow],
  )
  return isMaximized
}

function useTerminationRequests(
  mainWindow: MainWindowController,
  onCloseRequested: () => void,
): void {
  useEffect(() => {
    const channels = [
      {
        operation: 'register-close-listener',
        subscribe: () => mainWindow.onCloseRequested(onCloseRequested),
      },
      {
        operation: 'register-tray-quit-listener',
        subscribe: () => mainWindow.onTerminationRequested(onCloseRequested),
      },
    ]

    /* 兑现可能落在清理之后：那就地退订，别留一个悬空的监听。 */
    let disposed = false
    const disposers: Array<() => void> = []

    for (const channel of channels) {
      void channel.subscribe().then(
        (dispose) => {
          if (disposed) {
            dispose()
            return
          }

          disposers.push(dispose)
        },
        (cause: unknown) => {
          if (disposed) {
            return
          }

          reportFailure('WINDOW_CLOSE_LISTENER_UNAVAILABLE', {
            cause,
            operation: channel.operation,
            scope: 'app-shell',
          })
        },
      )
    }

    return () => {
      disposed = true

      for (const dispose of disposers) {
        dispose()
      }

      disposers.length = 0
    }
  }, [mainWindow, onCloseRequested])
}
