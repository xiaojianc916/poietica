import { useOverlayRef } from '@poietica/design-system'
import { useKernel, useObservable } from '@poietica/ui-kernel'
import type { ReactElement } from 'react'

export function Toasts(): ReactElement | null {
  const { kernelServices } = useKernel()
  const toasts = useObservable(kernelServices.toasts)
  /* 通知卡钉在右下角，正压在浏览器面板的原生视图上：不登记就会被网页盖住（P-07）。一张卡一份登记，空着的区域不算在场。 */
  const overlayRef = useOverlayRef<HTMLButtonElement>('anchored')
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
          ref={overlayRef}
          type="button"
        >
          <span className="workbench__toast-title">{t.title}</span>
          {t.detail === undefined ? null : <span className="workbench__toast-detail">{t.detail}</span>}
        </button>
      ))}
    </div>
  )
}
