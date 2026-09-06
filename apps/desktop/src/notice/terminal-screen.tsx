import type { TerminalFailureIncident } from '@poietica/problem'
import { CircleCheck as CheckCircle, Copy, RefreshCw as Refresh } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import errorRobotIllustration from './assets/error-robot.svg'
import { createTerminalFailureViewModel } from './problem-presentation'

export interface FatalErrorScreenProps {
  readonly incident: TerminalFailureIncident

  readonly additionalIncidentCount?: number
}

export function FatalErrorScreen({ incident, additionalIncidentCount = 0 }: FatalErrorScreenProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const details = useRef<HTMLDetailsElement>(null)

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
  )
}

function executePrimaryAction(action: { readonly kind: 'reload' }): void {
  switch (action.kind) {
    case 'reload':
      window.location.reload()
  }
}
