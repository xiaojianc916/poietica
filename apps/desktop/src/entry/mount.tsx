import { TableExportProvider } from '@poietica/conversation/table-export'
import type { ThemePreference } from '@poietica/design-system'
import { createMainWindowController } from '@poietica/native-bridge/window'
import { exportTable } from '@poietica/native-bridge/workspace/table-export'
import { type ReactNode, StrictMode, useMemo } from 'react'
import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { BrowserPickContext } from '../browser/pick-context'
import { FatalErrorHost } from '../notice/error-boundary'
import { markReactFatalHostMounted, reportFatalIncident } from '../notice/fatal-incident'
import { reportFailure } from '../notice/problem-presentation'
import { WorkspaceLayoutContext } from '../shell/layout/layout-context'
import { useWindowChrome } from '../window/use-window-chrome'
import { WindowControls } from '../window/window-controls'
import { AppShell } from '../workbench/app-shell'
import type { ApplicationRuntime } from '../workbench/runtime-contract'
import { WorkspaceRootsContext } from '../workspace/roots-context'
import { createApplicationRuntime } from './compose-runtime'

async function saveTable(content: string): Promise<void> {
  await exportTable({ content, format: 'markdown' })
}

function FatalWindowFrame({ children }: { readonly children: ReactNode }) {
  const mainWindow = useMemo(() => createMainWindowController(), [])

  const { isMaximized, minimize, toggleMaximize, quit } = useWindowChrome(
    mainWindow,
    async () => undefined,
  )

  return (
    <>
      {/* WindowControls 必须是拖拽区（fatal-drag-region）的兄弟节点：落进拖拽区的命中会被 WebView2 按 caption 吞掉按钮 click。 */}
      <div className="fixed inset-x-0 top-0 z-[var(--ui-z-chrome)] flex h-8 items-stretch">
        <div className="fatal-drag-region h-full flex-1" />

        <WindowControls
          isMaximized={isMaximized}
          onClose={quit}
          onMaximize={toggleMaximize}
          onMinimize={minimize}
        />
      </div>

      {children}
    </>
  )
}

function fatalFrame(screen: ReactNode): ReactNode {
  return <FatalWindowFrame>{screen}</FatalWindowFrame>
}

function reportReactError(input: {
  readonly code: string
  readonly collector: string
  readonly componentStack: string | null
  readonly error: unknown
}): void {
  reportFatalIncident({
    impact: 'application-fatal',
    error: input.error,
    kind: 'render',
    phase: 'running',
    code: input.code,
    componentStack: input.componentStack,
    context: {
      collector: input.collector,
    },
  })
}

export async function mountReactApplication(
  container: HTMLElement,
  restored: string | null,
): Promise<ApplicationRuntime> {
  let runtime: ReturnType<typeof createApplicationRuntime>

  try {
    runtime = createApplicationRuntime(restored)
  } catch (error: unknown) {
    reportFatalIncident({
      impact: 'application-fatal',
      error,
      kind: 'bootstrap',
      phase: 'runtime-construction',
      code: 'FATAL_APPLICATION_RUNTIME_CONSTRUCTION',
      context: {
        collector: 'react-root',
      },
    })

    throw error
  }

  let theme: ThemePreference = 'system'

  try {
    theme = (await runtime.settings.load()).theme
  } catch (cause: unknown) {
    reportFailure('SETTINGS_LOAD_FAILED', {
      cause,
      operation: 'load-settings',
      scope: 'application-runtime',
    })
  }

  try {
    await runtime.theme.setPreference(theme)
    runtime.start()

    const root: Root = createRoot(container, {
      onCaughtError: (error, info) => {
        reportReactError({
          code: 'FATAL_REACT_RENDER_ERROR',
          collector: 'react-error-boundary',
          componentStack: info.componentStack ?? null,
          error,
        })
      },

      onRecoverableError: (error, info) => {
        console.warn('[Poietica] React 从一次错误中恢复', error, info.componentStack)
      },

      onUncaughtError: (error, info) => {
        reportReactError({
          code: 'FATAL_REACT_UNCAUGHT_ERROR',
          collector: 'react-root',
          componentStack: info.componentStack ?? null,
          error,
        })
      },
    })

    runtime.own(() => root.unmount())
    markReactFatalHostMounted()

    /* 首帧同步提交：窗口以 visible: false 创建，呈现要等这一帧的 DOM 在位。 */
    flushSync(() => {
      root.render(
        <StrictMode>
          <TableExportProvider save={saveTable}>
            <FatalErrorHost frame={fatalFrame}>
              <WorkspaceRootsContext.Provider value={runtime.workspaceRoots}>
                <WorkspaceLayoutContext.Provider value={runtime.layout}>
                  <BrowserPickContext.Provider value={runtime.browserPick}>
                    <AppShell runtime={runtime} />
                  </BrowserPickContext.Provider>
                </WorkspaceLayoutContext.Provider>
              </WorkspaceRootsContext.Provider>
            </FatalErrorHost>
          </TableExportProvider>
        </StrictMode>,
      )
    })

    return runtime
  } catch (cause) {
    try {
      await runtime.dispose()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Application startup and shutdown failed.')
    }
    throw cause
  }
}
