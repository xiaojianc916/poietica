import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { cn } from '../class-names'
import { useOverlayRef } from '../overlay-presence'
import { Button } from './button'
import './menu.css'

export interface DialogProps {
  readonly open: boolean
  readonly title: string
  readonly description?: string
  readonly children?: ReactNode
  readonly footer?: ReactNode
  /** 表头右侧、关闭钮之前的一组操作（图标钮）；与关闭钮同一行、同一个高度 */
  readonly actions?: ReactNode
  readonly showHeader?: boolean
  readonly showCloseButton?: boolean
  readonly className?: string
  readonly contentClassName?: string
  readonly titleClassName?: string
  readonly descriptionClassName?: string
  readonly footerClassName?: string
  readonly busy?: boolean
  readonly closeOnOverlayClick?: boolean
  readonly onOpenChange: (open: boolean) => void
}

/*
 * 通用对话框的壳，几何照 zcode 的通用 Dialog（packages/ui/src/components/ui/dialog.tsx）：
 *
 *   遮罩   铺满视口、24% 黑（不模糊），180ms 淡入淡出
 *   卡     圆角 16、1px 描边、popover 底、shadow-md、内边距 16、块间距 16
 *   标题   14/500；说明 14/1.625、次要字色
 *   页脚   窄屏竖排倒序、宽屏右对齐（zcode 的 DialogFooter）
 *
 * 内边距统一由卡自己给（p-4）：表头 / 正文 / 页脚不再各带一条横向内边距，通栏铺满的调用点
 * （命令面板这类自己接管内边距的浮层）用 className 覆盖成 p-0 就行。
 * 宽度沿用本仓既有的 max-w-lg 默认：zcode 的通用 Dialog 自己只保证左右各留 16（100% - 2rem），
 * 宽度全归调用点；本仓多数调用点不写宽度，所以这里保留一条默认值，宽的那些自己覆盖。
 *
 * Base UI 管传送门生命周期、焦点圈禁、初始与最终焦点、Escape、外点按压与模态无障碍语义。
 */
export function Dialog({
  open,
  title,
  description,
  children,
  footer,
  actions,
  showHeader = true,
  showCloseButton = true,
  className,
  contentClassName,
  titleClassName,
  descriptionClassName,
  footerClassName,
  busy = false,
  closeOnOverlayClick = true,
  onOpenChange,
}: DialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  /* 弹层挂着就算在场：离场动画放完 Base UI 才卸它，原生视图不会抢在淡出前冒出来（见 overlay-presence）。 */
  const overlayRef = useOverlayRef<HTMLDivElement>('modal')

  const requestOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) {
      return
    }

    onOpenChange(nextOpen)
  }

  const closeButton = showCloseButton ? (
    <BaseDialog.Close
      disabled={busy}
      render={
        <Button
          aria-label="关闭"
          className="size-6 shrink-0"
          ref={closeButtonRef}
          size="icon"
          type="button"
          variant="ghost"
        />
      }
    >
      <X aria-hidden="true" />
    </BaseDialog.Close>
  ) : null

  return (
    <BaseDialog.Root
      disablePointerDismissal={busy || !closeOnOverlayClick}
      onOpenChange={(nextOpen) => {
        requestOpenChange(nextOpen)
      }}
      open={open}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={cn(
            'fixed inset-0',
            'z-[var(--ui-z-dialog)]',
            /*
             * 遮罩只压一层淡淡的黑（24%），不做模糊。这是「感觉得到、但还看得见底下」的那一档：
             * 再淡（8%）在浅色主题下几乎看不出这一层在场，再深就走到 zcode 那档 60% 的反面 ——
             * 那会把背后的对话整块推走，弹窗看着像另开了一屏。
             */
            'bg-black/24',
            'transition-opacity',
            'duration-[var(--ui-duration-normal)]',
            'ease-[var(--ui-ease-standard)]',
            'data-[starting-style]:opacity-0',
            'data-[ending-style]:opacity-0',
          )}
        />

        <BaseDialog.Viewport
          className={cn('fixed inset-0', 'z-[var(--ui-z-dialog)]', 'grid place-items-center', 'overflow-y-auto p-4')}
        >
          <BaseDialog.Popup
            aria-busy={busy || undefined}
            className={cn(
              'flex w-full max-w-lg',
              'max-h-[calc(100dvh-2rem)]',
              'flex-col gap-4 overflow-hidden',
              'rounded-2xl border',
              /*
               * 框色不在这里给：``* { border-color: var(--color-divider) }`` 是无层规则，压得过 utilities
               * （写 border-[var(--…)] 会被它整个吃掉）。这里只挂 ds-dialog，卡面那圈框由
               * control/menu.css 里那条无层规则统一声明成 zcode 的 border-popover-border 档位。
               */
              'ds-dialog',
              /*
               * 与浮层同一张脸：对话框也是浮起来的一层，深色下浮层那格比页面底色抬一档（见
               * tokens/dark.css）。
               */
              'bg-popover',
              'p-4',
              'text-sm',
              'leading-relaxed',
              'text-popover-foreground',
              'shadow-md outline-none',
              'transition-[transform,scale,opacity]',
              'duration-[var(--ui-duration-fast)]',
              'ease-[var(--ui-ease-standard)]',
              'data-[starting-style]:scale-95',
              'data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95',
              'data-[ending-style]:opacity-0',
              className,
            )}
            initialFocus={showHeader && showCloseButton ? closeButtonRef : undefined}
            ref={overlayRef}
          >
            {showHeader ? (
              <header className={cn('flex shrink-0', 'items-start', 'justify-between gap-4')}>
                <div className="min-w-0">
                  <BaseDialog.Title className={cn('text-sm font-medium', titleClassName)}>{title}</BaseDialog.Title>

                  {description ? (
                    <BaseDialog.Description
                      className={cn('mt-1 text-sm', 'leading-relaxed', 'text-muted-foreground', descriptionClassName)}
                    >
                      {description}
                    </BaseDialog.Description>
                  ) : null}
                </div>

                {actions === undefined || actions === null ? (
                  closeButton
                ) : (
                  <div className={cn('flex shrink-0', 'items-center gap-1')}>
                    {actions}
                    {closeButton}
                  </div>
                )}
              </header>
            ) : (
              /*
               * 模态对话框必须有名称。隐藏视觉表头不等于放弃无障碍名称：showHeader 为 false 时
               * header 整块不渲染，BaseDialog.Title 也随之消失，对话框就没有任何可访问名称了。
               */
              <BaseDialog.Title className={cn('sr-only', titleClassName)}>{title}</BaseDialog.Title>
            )}

            {children !== undefined && children !== null ? (
              <div className={cn('min-h-0 flex-1', 'overflow-auto', contentClassName)}>{children}</div>
            ) : null}

            {footer ? (
              <footer
                className={cn('flex shrink-0', 'flex-col-reverse gap-2', 'sm:flex-row sm:justify-end', footerClassName)}
              >
                {footer}
              </footer>
            ) : null}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
