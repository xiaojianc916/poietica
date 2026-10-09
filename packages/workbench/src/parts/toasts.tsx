import { useKernel, useObservable } from '@poietica/ui-kernel'
import type { ReactElement } from 'react'

/** Toast 浮层：右下角，来自内核的 toasts 服务 */
export function Toasts(): ReactElement | null {
  const { kernelServices } = useKernel()
  const toasts = useObservable(kernelServices.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="workbench__toasts" data-workbench-part="toasts" role="alert">
      {toasts.map((t) => (
        <button
          className={`workbench__toast workbench__toast--${t.severity}`}
          data-toast-severity={t.severity}
          key={t.id}
          onClick={() => {
            kernelServices.toasts.dismiss(t.id)
          }}
          type="button"
        >
          <span className="workbench__toast-title">{t.title}</span>
          {t.detail === undefined ? null : <span className="workbench__toast-detail">{t.detail}</span>}
        </button>
      ))}
    </div>
  )
}
