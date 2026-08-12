import type { FailureImpact } from '@poietica/core'
import { type ToastNotice, ToastRegion } from '@poietica/ui'
import { useSyncExternalStore } from 'react'
import {
  failureCoordinator,
  type NonTerminalFailureIncident,
  type PresentedFailure,
} from '../failures/coordinator'

/* 同时可见的通知上限：超出时保留最新几条，与主流桌面应用的通知栈一致。 */
const MAX_VISIBLE_NOTICES = 3

type ToastFailureImpact = Extract<FailureImpact, 'recoverable' | 'feature-degraded'>

type ToastIncident = NonTerminalFailureIncident & {
  readonly impact: ToastFailureImpact
}

type ToastFailure = Omit<PresentedFailure, 'incident'> & {
  readonly incident: ToastIncident
}

export function UiFeedbackRegion() {
  const snapshot = useSyncExternalStore(
    failureCoordinator.subscribe,
    failureCoordinator.getSnapshot,
    failureCoordinator.getSnapshot,
  )

  const visible = selectVisibleFailures([
    ...snapshot.operations,
    ...snapshot.degradedFeatures.values(),
  ]).slice(-MAX_VISIBLE_NOTICES)

  const notices = visible.map(toToastNotice)

  return (
    <ToastRegion
      notices={notices}
      onDismiss={(incidentId) => {
        failureCoordinator.dismiss(incidentId)
      }}
    />
  )
}

function toToastNotice(entry: ToastFailure): ToastNotice {
  const incident = entry.incident

  const degraded = incident.impact === 'feature-degraded'

  return {
    id: incident.id,
    title: incident.userMessage,
    description: incident.technicalMessage,
    tone: degraded ? 'warning' : 'danger',
    duration: degraded ? 9_000 : 5_500,
    priority: degraded ? 'low' : 'high',
  }
}

function selectVisibleFailures(failures: readonly PresentedFailure[]): ToastFailure[] {
  return failures.filter((entry): entry is ToastFailure => {
    if (!entry.noticeVisible) {
      return false
    }

    return entry.incident.impact === 'recoverable' || entry.incident.impact === 'feature-degraded'
  })
}
