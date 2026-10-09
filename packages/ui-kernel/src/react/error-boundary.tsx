import { lastResort } from '@poietica/foundation'
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  featureId: string
  children: ReactNode
}
interface State {
  error: Error | null
}

/** 一个功能的组件崩溃只影响它自己的区域。兜底界面的样式由 workbench 的 [data-feature-error] 规则提供 */
export class FeatureErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /* 功能组件崩溃是兜底路径，日志系统可能一起坏了：走日志不可用时的最后通道。 */
    lastResort(`[${this.props.featureId}] 组件错误：${error.message}`, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div data-feature-error={this.props.featureId} role="alert">
        <p data-feature-error-title>“{this.props.featureId}” 出现错误</p>
        <pre data-feature-error-detail>{this.state.error.message}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>
          重试
        </button>
      </div>
    )
  }
}
