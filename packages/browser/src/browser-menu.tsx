import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/ui'
import { ChevronDown, MoreHorizontal, Plus } from 'lucide-react'
import type { ReactNode } from 'react'

import type { BrowserState } from './browser-port'

/*
 * 面板三个菜单的唯一实现：加号、标签下拉、更多操作。
 *
 * 菜单是主文档里的 DOM，定位、碰撞翻转、键盘与 aria 归 @poietica/ui 的
 * DropdownMenu；展开期间原生子 webview 由 browser-dock 让位。
 */

/** 加号菜单里可开的通道种类，由宿主提供。 */
export interface DockPaneOffer {
  readonly kind: string
  readonly label: string
}

const triggerClassName =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100'

function MenuShell({
  children,
  icon,
  label,
  onOpenChange,
  open,
}: {
  readonly children: ReactNode
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
      {/* 标签多时菜单自己滚，不长到屏幕外；内联量纲不与表面类合流。 */}
      <DropdownMenuContent
        align="end"
        className="min-w-56"
        style={{ maxHeight: '20rem', overflowY: 'auto' }}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CurrentMark() {
  return <span className="ml-auto text-xs opacity-50">当前</span>
}

export function BrowserNewTabMenu({
  offers,
  onOpenChange,
  onOpenPane,
  onOpenTab,
  open,
}: {
  readonly offers: readonly DockPaneOffer[]
  readonly onOpenChange: (open: boolean) => void
  readonly onOpenPane: (kind: string) => void
  readonly onOpenTab: () => void
  readonly open: boolean
}) {
  return (
    <MenuShell
      icon={<Plus aria-hidden className="size-4" />}
      label="新建标签页"
      onOpenChange={onOpenChange}
      open={open}
    >
      <DropdownMenuItem onClick={onOpenTab}>新建标签页</DropdownMenuItem>
      {offers.length > 0 ? <DropdownMenuSeparator /> : null}
      {offers.map((offer) => (
        <DropdownMenuItem
          key={offer.kind}
          onClick={() => {
            onOpenPane(offer.kind)
          }}
        >
          {offer.label}
        </DropdownMenuItem>
      ))}
    </MenuShell>
  )
}

export function BrowserTabsMenu({
  activePaneId,
  host,
  onOpenChange,
  onReopenClosed,
  onSelectPane,
  onSelectTab,
  open,
  panes,
}: {
  readonly activePaneId: string | null
  readonly host: BrowserState
  readonly onOpenChange: (open: boolean) => void
  readonly onReopenClosed: (index: number) => void
  readonly onSelectPane: (id: string) => void
  readonly onSelectTab: (id: number) => void
  readonly open: boolean
  readonly panes: readonly { readonly id: string; readonly name: string }[]
}) {
  return (
    <MenuShell
      icon={<ChevronDown aria-hidden className="size-4" />}
      label="标签页列表"
      onOpenChange={onOpenChange}
      open={open}
    >
      {panes.map((pane) => (
        <DropdownMenuItem
          key={pane.id}
          onClick={() => {
            onSelectPane(pane.id)
          }}
        >
          <span className="min-w-0 truncate">{pane.name}</span>
          {pane.id === activePaneId ? <CurrentMark /> : null}
        </DropdownMenuItem>
      ))}
      {host.tabs.map((tab) => (
        <DropdownMenuItem
          key={tab.id}
          onClick={() => {
            onSelectTab(tab.id)
          }}
        >
          <span className="min-w-0 truncate">{tab.title}</span>
          {activePaneId === null && tab.id === host.activeTabId ? <CurrentMark /> : null}
        </DropdownMenuItem>
      ))}
      {host.recentlyClosed.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <div className="px-2 py-1 text-xs opacity-50">最近关闭</div>
        </>
      ) : null}
      {host.recentlyClosed.map((closed, index) => (
        <DropdownMenuItem
          key={closed.url}
          onClick={() => {
            onReopenClosed(index)
          }}
        >
          <span className="min-w-0 truncate">{closed.title}</span>
        </DropdownMenuItem>
      ))}
    </MenuShell>
  )
}

export function BrowserOverflowMenu({
  canDrive,
  onOpenChange,
  onOpenExternally,
  onPrint,
  open,
}: {
  readonly canDrive: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onOpenExternally: () => void
  readonly onPrint: () => void
  readonly open: boolean
}) {
  return (
    <MenuShell
      icon={<MoreHorizontal aria-hidden className="size-4" />}
      label="更多操作"
      onOpenChange={onOpenChange}
      open={open}
    >
      <DropdownMenuItem disabled={!canDrive} onClick={onPrint}>
        打印…
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canDrive} onClick={onOpenExternally}>
        在系统浏览器中打开
      </DropdownMenuItem>
    </MenuShell>
  )
}
