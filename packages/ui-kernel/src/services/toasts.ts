import { createId, type Disposable } from '@poietica/foundation'
import { describeError } from './errors'
import { createValue, type Observable } from './observable'

export interface Toast {
  readonly id: string
  readonly severity: 'info' | 'success' | 'warning' | 'error'
  readonly title: string
  readonly detail?: string
  readonly action?: { readonly label: string; readonly run: () => void }
  /** 0 表示不自动消失；error 默认 0，其余默认 4000 */
  readonly durationMs: number
}

export interface ToastService extends Observable<readonly Toast[]> {
  show(t: Omit<Toast, 'id' | 'durationMs'> & { durationMs?: number }): Disposable
  error(error: unknown, title?: string): Disposable
  dismiss(id: string): void
}

const MAX_VISIBLE = 5
/** 同一条错误在这个窗口内重复出现只显示一次 */
const DEDUPE_MS = 3_000

export function createToastService(errorMessages: Readonly<Record<string, string>>): ToastService {
  const list = createValue<readonly Toast[]>([])
  const recent = new Map<string, number>()
  const dismiss = (id: string): void => list.set(list.current().filter((t) => t.id !== id))
  const show: ToastService['show'] = (t) => {
    const key = t.detail === undefined ? t.title : `${t.title}|\u0000|${t.detail}`
    const now = Date.now()
    const last = recent.get(key)
    if (last !== undefined && now - last < DEDUPE_MS) return { dispose: () => undefined }
    recent.set(key, now)
    const toast: Toast = { ...t, id: createId(), durationMs: t.durationMs ?? (t.severity === 'error' ? 0 : 4_000) }
    list.set([...list.current(), toast].slice(-MAX_VISIBLE))
    if (toast.durationMs > 0) setTimeout(() => dismiss(toast.id), toast.durationMs)
    return { dispose: () => dismiss(toast.id) }
  }
  return {
    current: list.current,
    subscribe: list.subscribe,
    show,
    dismiss,
    error(error, title) {
      const d = describeError(error, errorMessages)
      return show({
        severity: 'error',
        title: title ?? d.title,
        detail: title === undefined ? d.detail : `${d.title}：${d.detail}`,
      })
    },
  }
}
