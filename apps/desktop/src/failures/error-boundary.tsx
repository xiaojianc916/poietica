import { Component, type ReactNode } from 'react'

interface FatalErrorBoundaryProps {
  readonly children: ReactNode
}

interface FatalErrorBoundaryState {
  readonly crashed: boolean
}

/*
 * 只管画什么，不管报什么。
 *
 * 上报归 root 的 onCaughtError（见 bootstrap/react-root.tsx），那里同时收得到没被
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
