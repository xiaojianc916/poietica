import { useKernel, useObservable } from '@poietica/ui-kernel'
import type { ReactElement } from 'react'

/** 模态确认框：同一时间只显示队首的一条 */
export function ConfirmHost(): ReactElement | null {
  const { kernelServices } = useKernel()
  const queue = useObservable(kernelServices.dialogs)
  const current = queue[0]
  if (current === undefined) return null
  return (
    <div className="workbench__modal-backdrop" data-workbench-part="confirm-host">
      <div aria-modal="true" className="workbench__modal" role="dialog">
        <h2 className="workbench__modal-title">{current.title}</h2>
        <p className="workbench__modal-body">{current.body}</p>
        <div className="workbench__modal-actions">
          <button
            className="workbench__button"
            data-confirm="cancel"
            onClick={() => {
              current.resolve(false)
            }}
            type="button"
          >
            {current.cancelLabel}
          </button>
          <button
            className={
              current.danger
                ? 'workbench__button workbench__button--danger'
                : 'workbench__button workbench__button--primary'
            }
            data-confirm="ok"
            onClick={() => {
              current.resolve(true)
            }}
            type="button"
          >
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
