import { createId } from '@poietica/foundation'
import { createValue, type Observable } from './observable'

export interface ConfirmRequest {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly danger: boolean
  readonly resolve: (ok: boolean) => void
}

export interface DialogService extends Observable<readonly ConfirmRequest[]> {
  confirm(o: {
    title: string
    body: string
    confirmLabel: string
    cancelLabel?: string
    danger?: boolean
  }): Promise<boolean>
}

/** 同一时间只显示队首的确认框；workbench 的 ConfirmHost 负责渲染并调用 resolve */
export function createDialogService(): DialogService {
  const queue = createValue<readonly ConfirmRequest[]>([])
  return {
    current: queue.current,
    subscribe: queue.subscribe,
    confirm: (o) =>
      new Promise<boolean>((resolve) => {
        const id = createId()
        const req: ConfirmRequest = {
          id,
          title: o.title,
          body: o.body,
          confirmLabel: o.confirmLabel,
          cancelLabel: o.cancelLabel ?? '取消',
          danger: o.danger ?? false,
          resolve: (ok) => {
            queue.set(queue.current().filter((r) => r.id !== id))
            resolve(ok)
          },
        }
        queue.set([...queue.current(), req])
      }),
  }
}
