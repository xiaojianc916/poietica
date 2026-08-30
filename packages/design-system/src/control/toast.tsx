import './toast.css'
import { CircleAlert } from 'lucide-react'
import { cn } from '../class-names'
export interface ToastNotice {
  readonly id: string
  readonly title: string
  readonly detail?: string
  /** 正在退场：元素得留到动画结束，何时移除由持有它的 store 说。 */
  readonly closing: boolean
}
export interface ToastRegionProps {
  readonly notices: readonly ToastNotice[]
  readonly onDismiss: (noticeId: string) => void
  readonly onHoverChange: (hovering: boolean) => void
}
/**
 * 失败通知的落地处：只读投影，不持有通知。
 *
 * 停留多久、什么时候退场、最多叠几张都在调用方的 store 里；这里只把 closing 翻成
 * data-state 交给 CSS。整张卡片就是那个关闭控件，所以没有叉。
 */
export function ToastRegion({ notices, onDismiss, onHoverChange }: ToastRegionProps) {
  return (
    <div
      className={cn(
        'pointer-events-none fixed right-8 bottom-12 z-[var(--ui-z-toast)]',
        'flex w-[min(400px,calc(100vw-64px))] flex-col gap-2',
      )}
      onMouseEnter={() => {
        onHoverChange(true)
      }}
      onMouseLeave={() => {
        onHoverChange(false)
      }}
      role="alert"
    >
      {notices.map((notice) => (
        <button
          aria-label="关闭这条提示"
          className={cn(
            'ui-toast pointer-events-auto flex items-start gap-3 text-left',
            'rounded-lg border border-divider bg-popover px-4 py-3',
            'text-popover-foreground shadow-md',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          data-state={notice.closing ? 'closed' : 'open'}
          key={notice.id}
          onClick={() => {
            onDismiss(notice.id)
          }}
          type="button"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="line-clamp-2 font-medium text-sm leading-5">{notice.title}</span>
            {notice.detail === undefined ? null : (
              <span className="line-clamp-3 break-words text-muted-foreground text-xs leading-5">
                {notice.detail}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}
