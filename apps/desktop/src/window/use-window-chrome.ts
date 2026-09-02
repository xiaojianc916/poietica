import type { MainWindowController } from '@poietica/native-bridge'
import { useCallback, useEffect, useState } from 'react'
import { reportFailure } from '../notice/problem-presentation'

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

  return { isMaximized, minimize, toggleMaximize, quit }
}

/*
 * 首帧问一次快照，此后只收窗口播报的翻转。
 *
 * 判定留在原生侧去抖（commands/window.rs 的 watch_maximized），过边界的只有真正的
 * 变化，所以这里没有并发的请求，也就不需要请求版本号去压竞态。
 */
function useMaximizedState(mainWindow: MainWindowController): boolean {
  const [isMaximized, setMaximized] = useState(false)

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined

    void mainWindow.isMaximized().then(
      (nextIsMaximized) => {
        if (!active) {
          return
        }

        setMaximized(nextIsMaximized)
      },
      (cause: unknown) => {
        if (!active) {
          return
        }

        reportFailure('WINDOW_STATE_QUERY_UNAVAILABLE', {
          scope: 'window-chrome',
          operation: 'query-window-maximized',
          cause,
        })
      },
    )

    void mainWindow.onMaximizedChanged(setMaximized).then(
      (nextUnsubscribe) => {
        if (!active) {
          nextUnsubscribe()
          return
        }

        unsubscribe = nextUnsubscribe
      },
      (cause: unknown) => {
        if (!active) {
          return
        }

        reportFailure('WINDOW_STATE_SYNC_UNAVAILABLE', {
          scope: 'window-chrome',
          operation: 'watch-window-maximized',
          cause,
        })
      },
    )

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [mainWindow])

  return isMaximized
}
