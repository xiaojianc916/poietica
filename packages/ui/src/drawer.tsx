import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './class-names'

export interface DrawerProps {
  readonly open: boolean
  readonly title: string
  readonly side?: 'left' | 'right'
  readonly closeLabel?: string
  readonly className?: string
  readonly children: ReactNode
  readonly onOpenChange: (open: boolean) => void
}

/**
 * 贴边模态抽屉。
 *
 * 与 Dialog 同源分工：Base UI 拥有 portal、焦点陷阱、初始与归还焦点、
 * Escape、外部点击与 aria-modal 语义；这里只拥有贴边定位与视觉令牌。
 *
 * 存在的理由是替换调用方各自手搓的"遮罩 + window keydown"假模态：
 * 那种写法没有焦点陷阱，Tab 会走到抽屉背后的内容上。
 */
export function Drawer({
  open,
  title,
  side = 'left',
  closeLabel = '关闭',
  className,
  children,
  onOpenChange,
}: DrawerProps) {
  return (
    <BaseDialog.Root onOpenChange={onOpenChange} open={open}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={cn(
            'fixed inset-0',
            'z-[var(--ui-z-dialog)]',
            'bg-black/35',
            'transition-opacity',
            'duration-[var(--ui-duration-normal)]',
            'ease-[var(--ui-ease-standard)]',
            'data-[starting-style]:opacity-0',
            'data-[ending-style]:opacity-0',
          )}
        />

        <BaseDialog.Popup
          className={cn(
            'fixed inset-y-0',
            'z-[var(--ui-z-dialog)]',
            'flex w-[min(82vw,320px)]',
            'flex-col overflow-hidden',
            'bg-sidebar text-foreground',
            'shadow-[var(--ui-shadow-xl)] outline-none',
            'transition-transform',
            'duration-[var(--ui-duration-normal)]',
            'ease-[var(--ui-ease-standard)]',
            side === 'left'
              ? [
                  'left-0 border-r border-divider',
                  'data-[starting-style]:-translate-x-full',
                  'data-[ending-style]:-translate-x-full',
                ]
              : [
                  'right-0 border-l border-divider',
                  'data-[starting-style]:translate-x-full',
                  'data-[ending-style]:translate-x-full',
                ],
            className,
          )}
        >
          {/* 模态必须有可访问名称；抽屉不展示视觉标题，所以只给辅助技术。 */}
          <BaseDialog.Title className="sr-only">{title}</BaseDialog.Title>

          {children}

          <BaseDialog.Close
            aria-label={closeLabel}
            className={cn(
              'absolute right-2 top-2',
              'inline-flex size-8 items-center justify-center',
              'rounded-md text-muted-foreground',
              'hover:bg-sidebar-accent hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <X aria-hidden="true" className="size-4" />
          </BaseDialog.Close>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
