import { Button, cn } from '@poietica/design-system'
import { Copy, Minus, Square, X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface WindowControlsProps {
  readonly isMaximized: boolean
  readonly onMinimize: () => void
  readonly onMaximize: () => void
  readonly onClose: () => void
}

export function WindowControls({
  isMaximized,
  onMinimize,
  onMaximize,
  onClose,
}: WindowControlsProps) {
  return (
    <div className="desktop-window-controls flex shrink-0 items-stretch">
      <WindowControlButton ariaLabel="最小化" onClick={onMinimize}>
        <Minus aria-hidden="true" />
      </WindowControlButton>

      <WindowControlButton ariaLabel={isMaximized ? '还原窗口' : '最大化窗口'} onClick={onMaximize}>
        {isMaximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}
      </WindowControlButton>

      <WindowControlButton ariaLabel="关闭" close onClick={onClose}>
        <X aria-hidden="true" />
      </WindowControlButton>
    </div>
  )
}

interface WindowControlButtonProps {
  readonly ariaLabel: string
  readonly children: ReactNode
  readonly onClick: () => void
  readonly close?: boolean
}

function WindowControlButton({
  ariaLabel,
  children,
  onClick,
  close = false,
}: WindowControlButtonProps) {
  return (
    <Button
      aria-label={ariaLabel}
      className={cn(
        'h-full rounded-none px-0 shadow-none text-muted-foreground',
        'focus-visible:relative focus-visible:z-10 focus-visible:ring-inset',
        close ? 'w-12' : 'w-11',
        close
          ? [
              'hover:bg-[var(--desktop-window-close-hover)]',
              'enabled:active:bg-[var(--desktop-window-close-active)]',
              'hover:text-[var(--desktop-window-close-foreground)]',
              'focus-visible:bg-[var(--desktop-window-close-hover)]',
              'focus-visible:text-[var(--desktop-window-close-foreground)]',
            ]
          : [
              'enabled:hover:bg-[var(--desktop-window-control-hover)]',
              'enabled:active:bg-[var(--desktop-window-control-active)]',
              'enabled:hover:text-foreground',
            ],
      )}
      onClick={onClick}
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  )
}
