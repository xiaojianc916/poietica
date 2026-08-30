import { type ReactNode, useSyncExternalStore } from 'react'
import { failureCoordinator } from './coordinator'
import { FatalErrorBoundary } from './error-boundary'
import { FatalErrorScreen } from './terminal-screen'

export interface FatalErrorHostProps {
  readonly children: ReactNode
}

export function FatalErrorHost({ children }: FatalErrorHostProps) {
  const snapshot = useSyncExternalStore(
    failureCoordinator.subscribe,
    failureCoordinator.getSnapshot,
    failureCoordinator.getSnapshot,
  )

  if (snapshot.terminal) {
    return (
      <FatalErrorScreen
        additionalIncidentCount={snapshot.terminal.additionalIncidentCount}
        incident={snapshot.terminal.incident}
      />
    )
  }

  return <FatalErrorBoundary>{children}</FatalErrorBoundary>
}
