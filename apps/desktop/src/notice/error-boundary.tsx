import { failureCoordinator } from '@poietica/problem'
import { Component, type ReactNode, useSyncExternalStore } from 'react'
import { FatalErrorScreen } from './terminal-screen'

interface FatalErrorBoundaryProps {
  readonly children: ReactNode
}

interface FatalErrorBoundaryState {
  readonly crashed: boolean
}

/*
 * 只管画什么，不管报什么。
 *
 * 上报归 root 的 onCaughtError（见 entry/mount.tsx），那里同时收得到没被
 * 接住的与已恢复的两种。留 getDerivedStateFromError 就足以成为错误边界 ——
 * componentDidCatch 从来不是成为边界的条件，它只是第二个上报口。
 */
export class FatalErrorBoundary extends Component<
  FatalErrorBoundaryProps,
  FatalErrorBoundaryState
> {
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
      // FatalErrorHost owns the only global fatal UI.
      return null
    }

    return this.props.children
  }
}

export interface FatalErrorHostProps {
  readonly children: ReactNode
}

/*
 * 终止失败的唯一接管者：coordinator 一说 terminal，整棵树换成致命屏。
 * 没有终止失败时，它退回一层错误边界 —— 边界接住渲染错误只为了让树安静地
 * 停住，上报在 root 那一侧。
 */
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
