import type { BrowserState, BrowserTab } from '@poietica/browser'
import { Globe, LoaderCircle, Maximize2, Minimize2, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { AuxiliaryNewTabMenu, type AuxiliaryPaneOffer } from './auxiliary-menu'
import type {
  AuxiliaryFocus,
  AuxiliaryMenuKind,
  AuxiliaryPanelStore,
} from './auxiliary-panel-store'

export interface DockPaneView {
  readonly id: string
  readonly name: string
  readonly icon: ReactNode
}

interface AuxiliaryTabStripProps {
  readonly host: BrowserState | null
  readonly actions: AuxiliaryPanelStore['actions']
  readonly panes: readonly DockPaneView[]
  readonly paneOffers: readonly AuxiliaryPaneOffer[]
  readonly focus: AuxiliaryFocus
  readonly onSelectPane: (id: string) => void
  readonly onClosePane: (id: string) => void
  readonly onOpenPane: AuxiliaryPanelStore['openLauncherPane']
  readonly openMenu: AuxiliaryMenuKind | null
  readonly onMenuChange: (kind: AuxiliaryMenuKind | null) => void
  /** 标签条里那枚全屏按钮：铺满主区+右栏，其余标签位不动。 */
  readonly fullscreen: boolean
  readonly onToggleFullscreen: () => void
}

interface AuxiliaryTabProps {
  readonly active: boolean
  readonly id: string
  readonly icon: ReactNode
  readonly title: string
  readonly onClose: () => void
  readonly onSelect: () => void
}

export const AUXILIARY_TABPANEL_ID = 'auxiliary-tabpanel'
export const auxiliaryPaneTabId = (id: string) => `auxiliary-pane-${id}`
export const auxiliaryBrowserTabId = (id: number) => `auxiliary-browser-${id}`

function moveTabFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return
  }

  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0 || tabs.length === 0) {
    return
  }

  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next]?.focus()
  tabs[next]?.click()
}

function closeFocusedTab(tab: HTMLButtonElement, onClose: () => void): void {
  const list = tab.closest('[role="tablist"]')
  const tabs = list === null ? [] : [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const index = tabs.indexOf(tab)
  const fallback = list?.parentElement?.querySelector<HTMLButtonElement>(
    '[data-auxiliary-tab-fallback] button',
  )
  const next = tabs[index + 1] ?? tabs[index - 1] ?? fallback

  next?.focus()
  if (next?.getAttribute('role') === 'tab') {
    next.click()
  }
  onClose()
}

function AuxiliaryTab({ active, icon, id, onClose, onSelect, title }: AuxiliaryTabProps) {
  return (
    <button
      aria-controls={AUXILIARY_TABPANEL_ID}
      aria-keyshortcuts="Delete"
      aria-selected={active}
      className={
        'flex min-w-24 max-w-44 shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-2 ' +
        (active ? 'bg-tab-active' : 'hover:bg-tab-hover')
      }
      id={id}
      onClick={(event) => {
        if ((event.target as Element).closest('[data-close-tab]') !== null) {
          onClose()
          return
        }
        onSelect()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Delete') {
          event.preventDefault()
          event.stopPropagation()
          closeFocusedTab(event.currentTarget, onClose)
        }
      }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('[data-close-tab]') !== null) {
          event.preventDefault()
        }
      }}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      <span aria-hidden className="auxiliary-tab-icon relative size-3.5 shrink-0">
        <span className="auxiliary-tab-icon__glyph pointer-events-none absolute inset-0 transition-opacity">
          {icon}
        </span>
        <X
          className="auxiliary-tab-icon__close pointer-events-none absolute inset-0 size-3.5 opacity-0 transition-opacity"
          data-close-tab
        />
      </span>
      <span className="min-w-0 truncate text-xs">{title}</span>
    </button>
  )
}

export function AuxiliaryTabStrip({
  host,
  actions,
  focus,
  paneOffers,
  panes,
  onClosePane,
  onMenuChange,
  onOpenPane,
  onSelectPane,
  openMenu,
  fullscreen,
  onToggleFullscreen,
}: AuxiliaryTabStripProps) {
  const [menuHeight, setMenuHeight] = useState(0)

  return (
    <div className="shrink-0">
      {/* 这一行与右上角那枚会话开关对齐，四条内边距都对着外壳那张卡片的圆角量：
          行高 40px 让 24px 的标签与 24px 的开关同高（都从面板顶下 8px 起）；
          左 = 圆角半径再让 4px —— 面板左上那个缺口是半径 16px 的四分之一圆，标签左缘
          落在 12px 时它的左上角顺着弧走，不再是一段被切掉的直角；
          右 = 圆角半径 + 开关那枚控件宽 + 行内间距（按钮与开关之间不留零缝）。

          全屏时外壳把开关收走（主列不在了，见 workspace-shell.css），这一份让位随之
          收回：加号与全屏按钮顺势右移，右缘落到开关原来压住的那条竖线上；退出全屏
          再让回来。让位与收回都走外壳写下的时间轴，见 auxiliary-panel.css。 */}
      <div
        className={
          'auxiliary-tab-strip__row flex h-10 shrink-0 items-center gap-1 pl-[calc(var(--workspace-card-radius)-0.25rem)] ' +
          (fullscreen
            ? 'pr-[var(--workspace-card-radius)]'
            : 'pr-[calc(var(--workspace-card-radius)+var(--workspace-card-control)+0.25rem)]')
        }
      >
        <div
          aria-label="辅助面板标签页"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          onKeyDown={moveTabFocus}
          role="tablist"
          style={{ scrollbarWidth: 'none' }}
        >
          {panes.map((pane) => (
            <AuxiliaryTab
              active={focus.kind === 'pane' && focus.id === pane.id}
              icon={pane.icon}
              id={auxiliaryPaneTabId(pane.id)}
              key={pane.id}
              onClose={() => {
                onClosePane(pane.id)
              }}
              onSelect={() => {
                onSelectPane(pane.id)
              }}
              title={pane.name}
            />
          ))}
          {(host?.tabs ?? []).map((tab) => (
            <AuxiliaryTab
              active={focus.kind === 'browser' && tab.id === host?.activeTabId}
              icon={<BrowserTabIcon tab={tab} />}
              id={auxiliaryBrowserTabId(tab.id)}
              key={tab.id}
              onClose={() => {
                actions.closeTab(tab.id)
              }}
              onSelect={() => {
                actions.selectTab(tab.id)
              }}
              title={tab.title}
            />
          ))}
        </div>

        <span className="contents" data-auxiliary-tab-fallback>
          <AuxiliaryNewTabMenu
            offers={paneOffers}
            onHeightChange={setMenuHeight}
            onOpenChange={(next) => {
              onMenuChange(next ? 'new-tab' : null)
            }}
            onOpenPane={onOpenPane}
            open={openMenu === 'new-tab'}
          />
        </span>

        <button
          aria-expanded={fullscreen}
          aria-label={fullscreen ? '退出全屏显示' : '全屏显示'}
          className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 enabled:hover:bg-launcher enabled:hover:opacity-100 aria-expanded:bg-current/10 aria-expanded:opacity-100"
          onClick={onToggleFullscreen}
          title={fullscreen ? '退出全屏显示' : '全屏显示'}
          type="button"
        >
          {fullscreen ? (
            <Minimize2 aria-hidden className="size-4" />
          ) : (
            <Maximize2 aria-hidden className="size-4" />
          )}
        </button>
      </div>
      {openMenu === 'new-tab' ? (
        /* 只负责让位：它自己不许画边。画了就是标签条下面凭空多一条线，
         * 而且高度是「菜单高 + 6」，那条线正好落在菜单下缘，看着像菜单漏出来的。 */
        <div aria-hidden className="bg-muted/30" style={{ blockSize: menuHeight }} />
      ) : null}
    </div>
  )
}

/* 标签的脸：装载中转圈，有站点图标就画它，否则地球。 */
function BrowserTabIcon({ tab }: { readonly tab: BrowserTab }) {
  if (tab.loading) {
    return <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin opacity-60" />
  }

  if (tab.favicon === null) {
    return <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
  }

  return <img alt="" className="size-3.5 shrink-0 rounded-sm" src={tab.favicon} />
}
