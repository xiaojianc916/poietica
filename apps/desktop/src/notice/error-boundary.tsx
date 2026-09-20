import { failureCoordinator } from '@poietica/problem'
import { Component, type ReactNode, useSyncExternalStore } from 'react'
import { FatalErrorScreen } from './terminal-screen'

interface FatalErrorBoundaryProps {
  readonly children: ReactNode
}

interface FatalErrorBoundaryState {
  readonly crashed: boolean
}

/* 只画不报：上报归 root 的 onCaughtError（见 entry/mount.tsx），getDerivedStateFromError 单独即构成错误边界。 */
class FatalErrorBoundary extends Component<FatalErrorBoundaryProps, FatalErrorBoundaryState> {
  override state: FatalErrorBoundaryState = {
    crashed: false,
  }

  static getDerivedStateFromError(): FatalErrorBoundaryState {
    return {
      crashed: true,
    }
  }

  override render(): ReactNode {
    if (this.state.crashed) {
      /* 全局致命 UI 由 FatalErrorHost 独有，这里退位。 */
      return null
    }

    return this.props.children
  }
}

export interface FatalErrorHostProps {
  readonly children: ReactNode
  readonly frame: (screen: ReactNode) => ReactNode
}

export function FatalErrorHost({ children, frame }: FatalErrorHostProps) {
  const snapshot = useSyncExternalStore(
    failureCoordinator.subscribe,
    failureCoordinator.getSnapshot,
    failureCoordinator.getSnapshot,
  )

  if (snapshot.terminal) {
    return frame(
      <FatalErrorScreen
        additionalIncidentCount={snapshot.terminal.additionalIncidentCount}
        incident={snapshot.terminal.incident}
      />,
    )
  }

  return <FatalErrorBoundary>{children}</FatalErrorBoundary>
}
