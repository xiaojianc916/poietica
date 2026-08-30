import { Button, cn } from '@poietica/design-system'
import { Copy, Minus, Square, X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface WindowControlsProps {
  readonly isMaximized: boolean
  readonly onMinimize: () => void
  readonly onMaximize: () => void
  readonly onClose: () => void
  readonly disabled?: boolean | undefined
}

/**
 * 窗口的最小化 / 最大化 / 关闭。
 *
 * 提出来是因为它有第二个使用者：应用崩溃屏。那里整条 AppShell 已经从树上消失，
 * 而窗口是无装饰的——没有这组按钮，用户除了杀进程没有别的出路。窗口控制属于
 * 非客户区，本来就不该随业务树一起死。
 *
 * 尺寸与原生红因此只有这一份。
 *
 * 字形尺寸不在这一份里：四枚字形一律走 :where(svg) 的 --ui-icon（16px），
 * 这里不写 size-* 工具类。此前它们是 14 / 14 / 12 / 16 四个值，最大化按钮
 * 在最大化与还原两个状态之间还会自己从 12 跳到 14 —— 那是三次各自独立的肉眼
 * 调参，没有人把它们放在一起看过。Windows 与 macOS 的窗口控制区都是一个尺寸。
 *
 * 16 也不是口味：24 网格的字形渲染到边长 S 时一格 = S / 24 * dpr 个设备像素，
 * dpr 1.5 下只有 S = 16 与 S = 32 能让它是整数。14 给出 0.875，12 给出 0.75，
 * 描边因此跨两列像素。
 */
export function WindowControls({
  isMaximized,
  onMinimize,
  onMaximize,
  onClose,
  disabled = false,
}: WindowControlsProps) {
  return (
    <div className="flex shrink-0 items-stretch">
      <WindowControlButton ariaLabel="最小化" disabled={disabled} onClick={onMinimize}>
        <Minus aria-hidden="true" />
      </WindowControlButton>

      <WindowControlButton
        ariaLabel={isMaximized ? '还原窗口' : '最大化窗口'}
        disabled={disabled}
        onClick={onMaximize}
      >
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
  readonly disabled?: boolean
  readonly close?: boolean
}

/*
 * 宽度由 close 推导，不从外面递进来。关闭键按 Windows 惯例比其余控制键
 * 宽一档，并且永不禁用——它走的是应用退出流程，不依赖原生窗口能力。
 */
function WindowControlButton({
  ariaLabel,
  children,
  onClick,
  disabled = false,
  close = false,
}: WindowControlButtonProps) {
  return (
    <Button
      aria-label={ariaLabel}
      className={cn(
        'h-full rounded-none',
        'px-0 shadow-none',
        'text-muted-foreground',
        'focus-visible:relative',
        'focus-visible:z-10',
        'focus-visible:ring-inset',
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
        disabled && 'cursor-not-allowed opacity-40',
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  )
}
