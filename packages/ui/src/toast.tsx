import { Toast as BaseToast } from '@base-ui/react/toast'
import { CircleAlert as DangerCircle, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from './class-names'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastNotice {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly tone?: ToastTone
  readonly duration?: number
  readonly priority?: 'low' | 'high'
}

export interface ToastRegionProps {
  readonly notices: readonly ToastNotice[]
  readonly onDismiss: (noticeId: string) => void
}

/**
 * Controlled application notices adapted to
 * the Base UI toast manager.
 *
 * The caller owns notice policy and state.
 * Base UI owns toast timing, focus, keyboard
 * navigation, pause and close lifecycle.
 */
export function ToastRegion({ notices, onDismiss }: ToastRegionProps) {
  return (
    <BaseToast.Provider timeout={0}>
      <ToastSynchronizer notices={notices} onDismiss={onDismiss} />

      <BaseToast.Portal>
        <BaseToast.Viewport
          className={cn(
            'pointer-events-none',
            'fixed bottom-4 right-4',
            'z-[var(--ui-z-toast)]',
            'w-[min(380px,calc(100vw-32px))]',
            'outline-none',
          )}
        >
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  )
}

function ToastSynchronizer({ notices, onDismiss }: ToastRegionProps) {
  const manager = BaseToast.useToastManager()

  const synchronizedRef = useRef(new Map<string, string>())

  const dismissRef = useRef(onDismiss)

  dismissRef.current = onDismiss

  useEffect(() => {
    const synchronized = synchronizedRef.current

    const currentIds = new Set(notices.map((notice) => notice.id))

    for (const existingId of synchronized.keys()) {
      if (currentIds.has(existingId)) {
        continue
      }

      manager.close(existingId)
      synchronized.delete(existingId)
    }

    for (const notice of notices) {
      const signature = createNoticeSignature(notice)

      const existingSignature = synchronized.get(notice.id)

      const options = {
        id: notice.id,
        title: notice.title,
        description: notice.description,
        type: notice.tone ?? 'info',
        timeout: notice.duration ?? 5_500,
        priority: notice.priority ?? 'low',
        onClose() {
          dismissRef.current(notice.id)
        },
      } as const

      if (existingSignature === undefined) {
        manager.add(options)
        synchronized.set(notice.id, signature)
        continue
      }

      if (existingSignature !== signature) {
        manager.update(notice.id, options)

        synchronized.set(notice.id, signature)
      }
    }
  }, [manager, notices])

  return null
}

function ToastList() {
  const manager = BaseToast.useToastManager()

  return manager.toasts.map((toast) => {
    const tone = normalizeTone(toast.type)

    return (
      <BaseToast.Root
        className={cn(
          'pointer-events-auto',
          'absolute bottom-0 right-0',
          'w-full',
          'rounded-lg border',
          'bg-background',
          'text-foreground',
          'shadow-xl',
          'outline-none',
          'transition-[transform,opacity]',
          'duration-[var(--ui-duration-normal)]',
          'ease-[var(--ui-ease-standard)]',
          'data-[starting-style]:translate-y-2',
          'data-[starting-style]:opacity-0',
          'data-[ending-style]:translate-y-2',
          'data-[ending-style]:opacity-0',
          'data-[expanded]:relative',
          'data-[expanded]:mb-2',
          tone === 'warning' && 'border-warning/40',
          tone === 'danger' && 'border-destructive/30',
          tone === 'info' && 'border-divider',
          tone === 'success' && 'border-primary/30',
        )}
        key={toast.id}
        swipeDirection={['down', 'right']}
        toast={toast}
      >
        <BaseToast.Content className={cn('flex items-start gap-3', 'p-3 text-sm')}>
          <DangerCircle
            aria-hidden="true"
            className={cn(
              'mt-0.5 size-4',
              'shrink-0',
              tone === 'warning' && 'text-warning',
              tone === 'danger' && 'text-destructive',
              tone === 'info' && 'text-muted-foreground',
              tone === 'success' && 'text-primary',
            )}
          />

          <div className={cn('grid min-w-0', 'flex-1 gap-1')}>
            <BaseToast.Title className="leading-5" />

            {toast.description ? (
              <BaseToast.Description className={cn('text-xs', 'text-muted-foreground')} />
            ) : null}
          </div>

          <BaseToast.Close
            aria-label="关闭提示"
            className={cn(
              'grid size-7',
              'shrink-0 place-items-center',
              'rounded-md',
              'text-muted-foreground',
              'outline-none',
              'hover:bg-accent',
              'hover:text-foreground',
              'focus-visible:ring-2',
              'focus-visible:ring-ring',
            )}
            type="button"
          >
            <X aria-hidden="true" />
          </BaseToast.Close>
        </BaseToast.Content>
      </BaseToast.Root>
    )
  })
}

function createNoticeSignature(notice: ToastNotice): string {
  return JSON.stringify({
    title: notice.title,
    description: notice.description ?? '',
    tone: notice.tone ?? 'info',
    duration: notice.duration ?? 5_500,
    priority: notice.priority ?? 'low',
  })
}

function normalizeTone(value: string | undefined): ToastTone {
  switch (value) {
    case 'success':
    case 'warning':
    case 'danger':
      return value

    default:
      return 'info'
  }
}
