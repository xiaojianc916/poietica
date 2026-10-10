import { ConfirmationDialog } from '@poietica/design-system'
import { useKernel, useObservable } from '@poietica/ui-kernel'
import type { ReactElement } from 'react'

/**
 * 模态确认框：同一时间只显示队首的一条。
 *
 * 外观归 design-system 的 ConfirmationDialog（与各功能里的二次确认同一个组件），
 * 外壳不再自绘一套样式 —— 手绘版本没有危险色、圆角与深色主题的对齐，长出了
 * 第二种确认框长相。
 */
export function ConfirmHost(): ReactElement | null {
  const { kernelServices } = useKernel()
  const queue = useObservable(kernelServices.dialogs)
  const current = queue[0]
  if (current === undefined) return null
  return (
    <ConfirmationDialog
      cancelLabel={current.cancelLabel}
      confirmLabel={current.confirmLabel}
      description={current.body}
      destructive={current.danger}
      onCancel={() => {
        current.resolve(false)
      }}
      onConfirm={() => {
        current.resolve(true)
      }}
      open
      title={current.title}
    />
  )
}
