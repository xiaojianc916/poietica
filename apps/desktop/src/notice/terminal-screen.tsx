import { createMainWindowController } from '@poietica/native-bridge'
import type { TerminalFailureIncident } from '@poietica/problem'
import { CircleCheck as CheckCircle, Copy, RefreshCw as Refresh } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWindowChrome } from '../window/use-window-chrome'
import { WindowControls } from '../window/window-controls'
import errorRobotIllustration from './assets/error-robot.svg'
import { createTerminalFailureViewModel } from './problem-presentation'

export interface FatalErrorScreenProps {
  readonly incident: TerminalFailureIncident

  readonly additionalIncidentCount?: number
}

export function FatalErrorScreen({ incident, additionalIncidentCount = 0 }: FatalErrorScreenProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const details = useRef<HTMLDetailsElement>(null)

  /*
   * 崩溃屏自己建 controller，不从 runtime 取：native-crash 那条启动路径上
   * runtime 从未被创建，而这个 controller 不持状态，每个方法现取窗口。
   */
  const mainWindow = useMemo(() => createMainWindowController(), [])

  const { isMaximized, minimize, toggleMaximize, quit } = useWindowChrome(mainWindow)

  const model = useMemo(
    () => createTerminalFailureViewModel(incident, additionalIncidentCount),
    [additionalIncidentCount, incident],
  )

  const primaryAction = model.primaryAction

  const copyLabels = {
    idle: model.copyActionLabel,
    copied: model.copySuccessLabel,
    failed: model.copyFailureLabel,
  }

  useEffect(() => {
    if (copyState === 'idle') {
      return
    }

    const resetTimer = window.setTimeout(() => {
      setCopyState('idle')
    }, model.copyResetDelayMs)

    return () => {
      window.clearTimeout(resetTimer)
    }
  }, [copyState, model.copyResetDelayMs])

  const copyDiagnostic = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(model.diagnostic)
      setCopyState('copied')
    } catch {
      setCopyState('failed')

      /* 复制不成时诊断文本必须自己露出来，否则用户没有第二条路。 */
      if (details.current) {
        details.current.open = true
      }
    }
  }

  return (
    <>
      {/*
       * 覆盖在客户区之上的非客户区，和原生 caption 一样：不介入 .fatal-surface
       * 自己的布局，居中内容原样不动。
       *
       * 填充区挂 fatal-drag-region，走 WebView2 原生可拖拽区域：拖动与双击
       * 最大化由系统非客户区处理。WindowControls 是填充区的兄弟节点，天然在
       * 拖拽区外——caption 命中会吞掉按钮的 click。
       */}
      <div className="fixed inset-x-0 top-0 z-50 flex h-8 items-stretch">
        <div className="fatal-drag-region h-full flex-1" />

        <WindowControls
          isMaximized={isMaximized}
          onClose={quit}
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
              aria-label={copyLabels[copyState]}
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

          <details className="fatal-details" ref={details}>
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
