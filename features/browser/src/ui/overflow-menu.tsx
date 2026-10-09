import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { ChevronRight, History, Minus, MoreHorizontal, Plus, RotateCcw } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef } from 'react'

/*
 * 浏览器工具栏右端那张「更多操作」菜单（07 页 §12E 的「缩放菜单」「最近关闭菜单」）。
 *
 * **迁移自** legacy `packages/workspace/src/panels/auxiliary-menu.tsx` 的 MenuShell /
 * OVERFLOW_ROWS / ZoomRow：菜单壳、行清单、行类名、缩放步进（一格 = 1.2 倍）一字未改。
 * 换掉的是三处口径：
 *
 *   - 行清单里「还没接进来」的那些条目不再假装存在（07 页只要缩放与最近关闭两张菜单），
 *     留着的行照 legacy 的写法画出灰行禁用；
 *   - 缩放范围按契约（`browser.setZoom` 限 -3…5），legacy 的 -7…8 是内核的边界、
 *     不是本架构的（07 页 §12B 的方法表就是权威）；
 *   - 最近关闭这一栏是新增的（legacy 没有 UI），行样式沿用同一套 DropdownMenuItem。
 */

const triggerClassName =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-launcher hover:opacity-100'

/** 行里的标签位：菜单里的每一行共用。 */
const labelClassName = 'min-w-0 flex-1 truncate text-xs'

function MenuShell({
  children,
  className,
  icon,
  label,
  onHeightChange,
  onOpenChange,
  open,
}: {
  readonly children: ReactNode
  readonly className: string
  readonly icon: ReactNode
  readonly label: string
  readonly onHeightChange: (height: number) => void
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}) {
  const popup = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const element = popup.current
    if (!open || element === null) {
      onHeightChange(0)
      return undefined
    }

    const report = (): void => {
      onHeightChange(Math.ceil(element.getBoundingClientRect().height + 6))
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [onHeightChange, open])

  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger aria-label={label} className={triggerClassName} title={label}>
        {icon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={className} ref={popup}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/*
 * 缩放：三个键都走宿主的 setZoomLevel，所以这里的「一档」就是内核的一档 ——
 * scale = 1.2 ^ level，一格 = 20%（Electron 文档原文）。范围取契约的 -3…5。
 */
const ZOOM_STEP = 1
export const ZOOM_MIN = -3
export const ZOOM_MAX = 5

function ZoomStep({
  children,
  label,
  onClick,
}: {
  readonly children: ReactNode
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-current/10"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function ZoomRow({ onZoom, level }: { readonly onZoom: (level: number) => void; readonly level: number }) {
  const percent = Math.round(1.2 ** level * 100)

  return (
    <fieldset aria-label="缩放" className="flex min-h-[var(--ui-control-height-sm)] items-center gap-1 px-2">
      <span className={labelClassName}>缩放</span>
      <ZoomStep label="缩小" onClick={() => onZoom(Math.max(ZOOM_MIN, level - ZOOM_STEP))}>
        <Minus aria-hidden className="size-3.5" />
      </ZoomStep>
      <span className="w-10 shrink-0 text-center text-xs tabular-nums opacity-70">{percent}%</span>
      <ZoomStep label="放大" onClick={() => onZoom(Math.min(ZOOM_MAX, level + ZOOM_STEP))}>
        <Plus aria-hidden className="size-3.5" />
      </ZoomStep>
      <ZoomStep label="重置缩放" onClick={() => onZoom(0)}>
        <RotateCcw aria-hidden className="size-3.5" />
      </ZoomStep>
    </fieldset>
  )
}

export interface BrowserOverflowMenuProps {
  readonly onHeightChange: (height: number) => void
  readonly onOpenChange: (open: boolean) => void
  readonly onReopen: (index: number) => void
  readonly onZoom: (level: number) => void
  readonly open: boolean
  readonly recentlyClosed: readonly { readonly url: string; readonly title: string }[]
  readonly zoomLevel: number
}

type OverflowRow =
  | { readonly kind: 'divider'; readonly id: string }
  | { readonly kind: 'zoom'; readonly id: string }
  | {
      readonly kind: 'command'
      readonly id: string
      readonly label: string
      readonly disabled?: true
      readonly submenu?: true
    }

/*
 * 行清单只有这一份，**与 legacy 的 OVERFLOW_ROWS 一字不差**（07 页 §12E 只点名了缩放与
 * 最近关闭两张菜单，其余条目还没有命令面：照 legacy 画出灰行禁用，不假装它们能用）。
 */
const OVERFLOW_ROWS: readonly OverflowRow[] = [
  { kind: 'command', id: 'find-in-page', label: '在页面中查找' },
  { kind: 'command', id: 'print', label: '打印', disabled: true },
  { kind: 'divider', id: 'after-print' },
  { kind: 'zoom', id: 'zoom' },
  { kind: 'divider', id: 'after-zoom' },
  { kind: 'command', id: 'device-toolbar', label: '显示设备工具栏' },
  { kind: 'command', id: 'screenshot', label: '截取屏幕截图', disabled: true },
  { kind: 'divider', id: 'after-capture' },
  { kind: 'command', id: 'import-credentials', label: '导入 Cookie 和密码…' },
  { kind: 'command', id: 'credentials', label: '密码和自动填充', submenu: true },
  { kind: 'command', id: 'downloads', label: '下载' },
  { kind: 'command', id: 'history', label: '历史记录' },
  { kind: 'command', id: 'clear-browsing-data', label: '清除浏览数据' },
  { kind: 'divider', id: 'after-data' },
  { kind: 'command', id: 'settings', label: '浏览器设置' },
]

export function BrowserOverflowMenu({
  onHeightChange,
  onOpenChange,
  onReopen,
  onZoom,
  open,
  recentlyClosed,
  zoomLevel,
}: BrowserOverflowMenuProps) {
  return (
    <MenuShell
      className="w-64"
      icon={<MoreHorizontal aria-hidden className="size-4" />}
      label="更多操作"
      onHeightChange={onHeightChange}
      onOpenChange={onOpenChange}
      open={open}
    >
      {OVERFLOW_ROWS.map((row) => {
        if (row.kind === 'divider') {
          return <DropdownMenuSeparator key={row.id} />
        }

        if (row.kind === 'zoom') {
          return <ZoomRow key={row.id} level={zoomLevel} onZoom={onZoom} />
        }

        return (
          <DropdownMenuItem disabled={row.disabled ?? false} key={row.id}>
            <span className={labelClassName}>{row.label}</span>
            {row.submenu === true ? <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-50" /> : null}
          </DropdownMenuItem>
        )
      })}

      {/*
       * 「最近关闭」是 07 页 §12E 点名、而 legacy 里没有 UI 的那一栏：接在 legacy 那张
       * 行清单之后，行样式沿用同一套 DropdownMenuItem，不另立一套视觉。
       */}
      <DropdownMenuSeparator />
      {recentlyClosed.length === 0 ? (
        <DropdownMenuItem disabled>
          <span className={labelClassName}>没有最近关闭的标签页</span>
        </DropdownMenuItem>
      ) : (
        recentlyClosed.map((tab, index) => (
          <DropdownMenuItem
            key={`${tab.url}#${String(index)}`}
            onClick={() => {
              onReopen(index)
            }}
          >
            <History aria-hidden className="size-3.5 shrink-0 opacity-50" />
            <span className={labelClassName}>{tab.title}</span>
            <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-50" />
          </DropdownMenuItem>
        ))
      )}
    </MenuShell>
  )
}
