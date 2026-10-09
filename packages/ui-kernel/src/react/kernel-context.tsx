import { createContext, type ReactNode, useContext } from 'react'
import type { UiKernel } from '../kernel'
import { FeatureErrorBoundary } from './error-boundary'

const KernelContext = createContext<UiKernel | null>(null)
const FeatureContext = createContext<string | null>(null)

export function KernelProvider({ kernel, children }: { kernel: UiKernel; children: ReactNode }): ReactNode {
  return <KernelContext.Provider value={kernel}>{children}</KernelContext.Provider>
}

export function useKernel(): UiKernel {
  const k = useContext(KernelContext)
  if (k === null) throw new Error('useKernel 必须在 KernelProvider 内使用')
  return k
}

/** workbench 用它包裹每一个贡献出来的组件：提供错误边界 + 功能身份（useService 据此做访问控制） */
export function FeatureScope({ featureId, children }: { featureId: string; children: ReactNode }): ReactNode {
  return (
    <FeatureContext.Provider value={featureId}>
      <FeatureErrorBoundary featureId={featureId}>{children}</FeatureErrorBoundary>
    </FeatureContext.Provider>
  )
}

export function useFeatureId(): string {
  const id = useContext(FeatureContext)
  if (id === null) throw new Error('该组件没有被 FeatureScope 包裹')
  return id
}
