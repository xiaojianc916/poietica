import type { BrowserState } from '@poietica/browser'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import {
  ChevronDown,
  ChevronRight,
  Globe,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { AuxiliaryFocus, AuxiliaryLauncherKind } from './auxiliary-panel-store'
import { BrowserTabIcon } from './browser-tab-icon'

/*
 * 面板三张菜单的唯一实现：加号、标签下拉、更多操作。
 *
 * 菜单是主文档里的 DOM，定位、碰撞翻转、键盘与 aria 归 @poietica/design-system 的
 * DropdownMenu；展开期间原生子 webview 由 browser-dock 让位。行高读控件小号
 * 令牌、字号 text-xs —— 与标签条同一套量纲，量纲一律走类。
 */

/** 加号菜单里可开的通道种类，由宿主提供。 */
export interface AuxiliaryPaneOffer {
  readonly kind: AuxiliaryLauncherKind
  readonly label: string
  readonly description: string
  readonly availability: 'ready' | 'planned'
  readonly icon: ReactNode
}

const triggerClassName =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100'

/** 行里的标签位：一份，三张菜单共用。 */
const labelClassName = 'min-w-0 flex-1 truncate text-xs'

const groupClassName = 'px-2 pb-1 pt-1.5 text-[11px] opacity-50'

/* 搜索框吃自己的按键；导航键留给菜单。 */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'])

function MenuShell({
  children,
  className,
  icon,
  label,
  onOpenChange,
  open,
}: {
  readonly children: ReactNode
  readonly className: string
  readonly icon: ReactNode
  readonly label: string
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger aria-label={label} className={triggerClassName} title={label}>
        {icon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={className}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CurrentMark() {
  return <span className="shrink-0 text-[11px] opacity-50">当前</span>
}

function matches(needle: string, title: string, url: string | null): boolean {
  if (needle === '') {
    return true
  }

  return title.toLowerCase().includes(needle) || (url ?? '').toLowerCase().includes(needle)
}

export function AuxiliaryNewTabMenu({
  offers,
  onOpenChange,
  onOpenPane,
  open,
}: {
  readonly offers: readonly AuxiliaryPaneOffer[]
  readonly onOpenChange: (open: boolean) => void
  readonly onOpenPane: (kind: AuxiliaryLauncherKind) => void
  readonly open: boolean
}) {
  return (
    <MenuShell
      className="min-w-40"
      icon={<Plus aria-hidden className="size-4" />}
      label="新建标签页"
      onOpenChange={onOpenChange}
      open={open}
    >
      {offers.map((offer) => (
        <DropdownMenuItem
          key={offer.kind}
          onClick={() => {
            onOpenPane(offer.kind)
          }}
        >
          {offer.icon}
          <span className={labelClassName}>{offer.label}</span>
        </DropdownMenuItem>
      ))}
    </MenuShell>
  )
}

export function AuxiliaryTabsMenu({
  focus,
  host,
  onOpenChange,
  onReopenClosed,
  onSelectPane,
  onSelectTab,
  open,
  panes,
}: {
  readonly focus: AuxiliaryFocus
  readonly host: BrowserState
  readonly onOpenChange: (open: boolean) => void
  readonly onReopenClosed: (index: number) => void
  readonly onSelectPane: (id: string) => void
  readonly onSelectTab: (id: number) => void
  readonly open: boolean
  readonly panes: readonly {
    readonly id: string
    readonly name: string
    readonly icon: ReactNode
  }[]
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shownPanes = panes.filter((pane) => matches(needle, pane.name, null))
  const shownTabs = host.tabs.filter((tab) => matches(needle, tab.title, tab.url))
  const shownClosed = host.recentlyClosed
    .map((closed, index) => ({ closed, index }))
    .filter((entry) => matches(needle, entry.closed.title, entry.closed.url))

  return (
    <MenuShell
      className="w-72"
      icon={<ChevronDown aria-hidden className="size-4" />}
      label="标签页列表"
      onOpenChange={(next) => {
        if (!next) {
          setQuery('')
        }

        onOpenChange(next)
      }}
      open={open}
    >
      <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-divider px-2 py-1.5">
        <Search aria-hidden className="size-3.5 shrink-0 opacity-50" />
        <input
          aria-label="搜索标签页"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:opacity-50"
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (!MENU_KEYS.has(event.key)) {
              event.stopPropagation()
            }
          }}
          placeholder="搜索标签页…"
          value={query}
        />
      </div>

      <div className="max-h-72 overflow-y-auto">
        {shownPanes.length + shownTabs.length > 0 ? (
          <p className={groupClassName}>打开的标签页</p>
        ) : null}
        {shownPanes.map((pane) => (
          <DropdownMenuItem
            key={pane.id}
            onClick={() => {
              onSelectPane(pane.id)
            }}
          >
            {pane.icon}
            <span className={labelClassName}>{pane.name}</span>
            {focus.kind === 'pane' && focus.id === pane.id ? <CurrentMark /> : null}
          </DropdownMenuItem>
        ))}
        {shownTabs.map((tab) => (
          <DropdownMenuItem
            key={tab.id}
            onClick={() => {
              onSelectTab(tab.id)
            }}
          >
            <BrowserTabIcon tab={tab} />
            <span className={labelClassName}>{tab.title}</span>
            {focus.kind === 'browser' && tab.id === host.activeTabId ? <CurrentMark /> : null}
          </DropdownMenuItem>
        ))}
        {shownClosed.length > 0 ? <p className={groupClassName}>最近关闭的标签页</p> : null}
        {shownClosed.map((entry) => (
          <DropdownMenuItem
            key={entry.closed.url}
            onClick={() => {
              onReopenClosed(entry.index)
            }}
          >
            <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
            <span className={labelClassName}>{entry.closed.title}</span>
          </DropdownMenuItem>
        ))}
        {shownPanes.length + shownTabs.length + shownClosed.length === 0 ? (
          <p className={groupClassName}>没有匹配的标签页</p>
        ) : null}
      </div>
    </MenuShell>
  )
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

/* 行清单只有这一份。命令还没接进来：灰行禁用，其余点了只关菜单。 */
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

/* 缩放的三个键只画不做事：面板还没有缩放这条命令。 */
function ZoomStep({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <button
      aria-label={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-50"
      disabled
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function ZoomRow() {
  return (
    <fieldset
      aria-label="缩放"
      className="flex min-h-[var(--ui-control-height-sm)] items-center gap-1 px-2"
    >
      <span className={labelClassName}>缩放</span>
      <ZoomStep label="缩小">
        <Minus aria-hidden className="size-3.5" />
      </ZoomStep>
      <span className="w-10 shrink-0 text-center text-xs tabular-nums opacity-70">100%</span>
      <ZoomStep label="放大">
        <Plus aria-hidden className="size-3.5" />
      </ZoomStep>
      <ZoomStep label="重置缩放">
        <RotateCcw aria-hidden className="size-3.5" />
      </ZoomStep>
    </fieldset>
  )
}

export function BrowserOverflowMenu({
  onOpenChange,
  open,
}: {
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}) {
  return (
    <MenuShell
      className="w-64"
      icon={<MoreHorizontal aria-hidden className="size-4" />}
      label="更多操作"
      onOpenChange={onOpenChange}
      open={open}
    >
      {OVERFLOW_ROWS.map((row) => {
        if (row.kind === 'divider') {
          return <DropdownMenuSeparator key={row.id} />
        }

        if (row.kind === 'zoom') {
          return <ZoomRow key={row.id} />
        }

        return (
          <DropdownMenuItem disabled={row.disabled ?? false} key={row.id}>
            <span className={labelClassName}>{row.label}</span>
            {row.submenu === true ? (
              <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-50" />
            ) : null}
          </DropdownMenuItem>
        )
      })}
    </MenuShell>
  )
}
