import type { MainWindowController } from '@poietica/native-bridge'
import { useCallback, useEffect, useState } from 'react'
import { reportFailure } from '../notice/problem-presentation'

interface WindowChrome {
  readonly isMaximized: boolean
  readonly minimize: () => void
  readonly toggleMaximize: () => void
}

/**
 * 窗口控制按钮需要的一切：当前是否最大化，以及两个动作。
 *
 * 关闭不在这里。正常界面的关闭要先过未保存确认，崩溃屏上那条流程所依赖的组件树
 * 已经不存在了——这是两种策略，不是同一个动作的两个参数，各自留在调用点。
 */
export function useWindowChrome(mainWindow: MainWindowController): WindowChrome {
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

  return { isMaximized, minimize, toggleMaximize }
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
