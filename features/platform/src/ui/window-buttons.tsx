import { Button, cn } from '@poietica/design-system'
import { Copy, Minus, Square, X } from 'lucide-react'
import { type ReactElement, type ReactNode, useEffect, useState } from 'react'
import type { PlatformApi } from './api'

/*
 * 窗口按钮。**迁移自** legacy `window/window-controls.tsx`：三枚 design-system 的
 * Button（variant ghost、size icon、rounded-none、w-11 / 关闭 w-12），字形取 lucide
 * 的 Minus / Square / Copy / X。悬停色读 desktop 令牌（app.css 那一族）。
 *
 * 只改数据来源：legacy 的回调由宿主注入，这里走 platform 契约。
 */
export function WindowButtons({ api }: { readonly api: PlatformApi }): ReactElement {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api.isMaximized().then((r) => {
      if (!cancelled) setMaximized(r.maximized)
    })
    const sub = api.onMaximizedChanged((next) => setMaximized(next))
    return () => {
      cancelled = true
      sub.dispose()
    }
  }, [api])

  return (
    <div className="desktop-window-controls flex shrink-0 items-stretch" data-window-buttons>
      <WindowControlButton ariaLabel="最小化" data-window-button="minimize" onClick={() => void api.minimize()}>
        <Minus aria-hidden="true" />
      </WindowControlButton>

      <WindowControlButton
        ariaLabel={maximized ? '还原窗口' : '最大化窗口'}
        data-maximized={maximized}
        data-window-button="maximize"
        onClick={() => void api.toggleMaximize()}
      >
        {maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}
      </WindowControlButton>

      <WindowControlButton ariaLabel="关闭" close data-window-button="close" onClick={() => void api.close()}>
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
  readonly 'data-window-button': string
  readonly 'data-maximized'?: boolean
}

function WindowControlButton({
  ariaLabel,
  children,
  onClick,
  close = false,
  ...rest
}: WindowControlButtonProps): ReactElement {
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
      {...rest}
    >
      {children}
    </Button>
  )
}
