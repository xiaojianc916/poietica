import { createMainWindowController } from '@poietica/desktop-adapters'
import { CircleCheck as CheckCircle, Copy, RefreshCw as Refresh } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useWindowChrome } from '../chrome/use-window-chrome'
import { WindowControls } from '../chrome/window-controls'
import errorRobotIllustration from './assets/error-robot.svg'
import type { TerminalFailureIncident } from './coordinator'
import { createTerminalFailureViewModel } from './terminal-view-model'

export interface FatalErrorScreenProps {
  readonly incident: TerminalFailureIncident

  readonly additionalIncidentCount?: number
}

export function FatalErrorScreen({ incident, additionalIncidentCount = 0 }: FatalErrorScreenProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')

  /*
   * 崩溃屏自己建 controller，不从 runtime 取：native-crash 那条启动路径上
   * runtime 从未被创建，而这个 controller 不持状态，每个方法现取窗口。
   */
  const mainWindow = useMemo(() => createMainWindowController(), [])

  const { isMaximized, minimize, toggleMaximize } = useWindowChrome(mainWindow)

  /*
   * 关闭走 forceClose 而不是 close。close 触发原生 CloseRequested，而应答它的
   * 未保存确认对话框由已经卸载的 AppShell 渲染：一旦有监听器残留并
   * preventDefault，窗口将永远关不掉。那条确认流程在崩溃屏上并不存在。
   */
  const closeWindow = () => {
    mainWindow.forceClose()
  }

  const model = useMemo(
    () => createTerminalFailureViewModel(incident, additionalIncidentCount),
    [additionalIncidentCount, incident],
  )

  const primaryAction = model.primaryAction

  useEffect(() => {
    if (copyState !== 'copied') {
      return
    }

    const resetTimer = window.setTimeout(() => {
      setCopyState('idle')
    }, 2200)

    return () => {
      window.clearTimeout(resetTimer)
    }
  }, [copyState])

  const copyDiagnostic = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(model.diagnostic)
      setCopyState('copied')
    } catch {
      // Keep the copy icon available so the user can retry immediately.
      setCopyState('idle')
    }
  }

  return (
    <>
      {/*
       * 覆盖在客户区之上的非客户区，和原生 caption 一样：不介入 .fatal-surface
       * 自己的布局，居中内容原样不动。
       *
       * 填充区标注 data-tauri-drag-region，拖动与双击最大化交给 webview；按钮
       * 不标注，原生拖拽一旦开始就会吞掉 click。
       */}
      <div className="fixed inset-x-0 top-0 z-50 flex h-8 items-stretch">
        <div className="h-full flex-1" data-tauri-drag-region />

        <WindowControls
          isMaximized={isMaximized}
          onClose={closeWindow}
          onMaximize={toggleMaximize}
          onMinimize={minimize}
        />
      </div>

      <main aria-live="assertive" className="fatal-surface" role="alert">
        <section className="fatal-content">
          <img
            alt=""
            aria-hidden="true"
            className="fatal-illustration"
            src={errorRobotIllustration}
          />

          <h1 className="fatal-title">{model.title}</h1>

          <p className="fatal-description">{model.description}</p>

          <p className="fatal-summary">{model.summary}</p>

          {model.additionalIncidentMessage ? (
            <p className="fatal-secondary">{model.additionalIncidentMessage}</p>
          ) : null}

          <div className="fatal-actions">
            {primaryAction ? (
              <button
                aria-label={primaryAction.label}
                className="fatal-icon-button"
                onClick={() => {
                  executePrimaryAction(primaryAction)
                }}
                type="button"
              >
                <Refresh aria-hidden="true" />
              </button>
            ) : null}

            <button
              aria-label={copyState === 'copied' ? model.copySuccessLabel : model.copyActionLabel}
              className="fatal-icon-button"
              onClick={() => {
                void copyDiagnostic()
              }}
              type="button"
            >
              {copyState === 'copied' ? (
                <CheckCircle aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
            </button>
          </div>

          <details className="fatal-details">
            <summary>{model.detailsLabel}</summary>

            <pre className="fatal-diagnostic">{model.diagnostic}</pre>
          </details>
        </section>
      </main>
    </>
  )
}

function executePrimaryAction(action: { readonly kind: 'reload' }): void {
  switch (action.kind) {
    case 'reload':
      window.location.reload()
  }
}
