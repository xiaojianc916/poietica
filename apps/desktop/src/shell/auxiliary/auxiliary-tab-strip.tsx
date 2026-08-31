import type { BrowserState } from '@poietica/browser'
import { X } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { AuxiliaryNewTabMenu, type AuxiliaryPaneOffer, AuxiliaryTabsMenu } from './auxiliary-menu'
import type {
  AuxiliaryFocus,
  AuxiliaryMenuKind,
  AuxiliaryPanelStore,
} from './auxiliary-panel-store'
import { BrowserTabIcon } from './browser-tab-icon'

/*
 * 标签条与标签下拉。
 *
 * 一格通道与一个宿主标签在这里是同一种行：同样的选中态、同样的关闭键，也同样进
 * 下拉里的那一份清单 —— 清单只有一份，两个出口读的是同一批行。
 */

/** 标签行上一格通道的样子。 */
export interface DockPaneView {
  readonly id: string
  readonly name: string
  readonly icon: ReactNode
}

interface AuxiliaryTabStripProps {
  readonly host: BrowserState
  readonly actions: AuxiliaryPanelStore['actions']
  readonly panes: readonly DockPaneView[]
  readonly paneOffers: readonly AuxiliaryPaneOffer[]
  readonly focus: AuxiliaryFocus
  readonly onSelectPane: (id: string) => void
  readonly onClosePane: (id: string) => void
  readonly onOpenPane: AuxiliaryPanelStore['openLauncherPane']
  readonly openMenu: AuxiliaryMenuKind | null
  readonly onMenuChange: (kind: AuxiliaryMenuKind | null) => void
  /** 行尾角位：宿主放面板开关。 */
  readonly trailing?: ReactNode
}

export const AUXILIARY_TABPANEL_ID = 'auxiliary-tabpanel'
export const auxiliaryPaneTabId = (id: string) => `auxiliary-pane-${id}`
export const auxiliaryBrowserTabId = (id: number) => `auxiliary-browser-${id}`

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
  trailing,
}: AuxiliaryTabStripProps) {
  const moveTabFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
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

  return (
    <div
      aria-label="辅助面板标签页"
      className="flex h-8 shrink-0 items-center gap-1 border-b border-current/10 px-1"
      onKeyDown={moveTabFocus}
      role="tablist"
    >
      {/* 行高与宿主页头一致（32px）：角位上的开关在开合两态间零位移。 */}
      {/* 原生横向滚动条占布局高度，会把 24px 的标签顶出 32px 的行；内联藏掉，
            不走类扫描与构建链。溢出导航：触控板横滑、Shift+滚轮、左端标签列表。 */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        {panes.map((pane) => {
          const active = focus.kind === 'pane' && focus.id === pane.id

          return (
            <div
              className={
                'group flex max-w-44 shrink-0 items-center rounded-md ' +
                (active ? 'bg-current/[7.8%]' : 'hover:bg-current/5')
              }
              key={pane.id}
            >
              <button
                aria-controls={AUXILIARY_TABPANEL_ID}
                aria-selected={active}
                className="flex min-w-0 items-center gap-1.5 py-1 pl-2 pr-1"
                id={auxiliaryPaneTabId(pane.id)}
                onClick={() => {
                  onSelectPane(pane.id)
                }}
                role="tab"
                tabIndex={active ? 0 : -1}
                title={pane.name}
                type="button"
              >
                {pane.icon}
                <span className="min-w-0 truncate text-xs">{pane.name}</span>
              </button>
              <button
                aria-label="关闭标签页"
                className="mr-1 rounded p-0.5 opacity-0 hover:bg-current/10 group-hover:opacity-60 hover:opacity-100"
                onClick={() => {
                  onClosePane(pane.id)
                }}
                type="button"
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
          )
        })}
        {host.tabs.map((tab) => {
          const active = focus.kind === 'browser' && tab.id === host.activeTabId

          return (
            <div
              className={
                'group flex max-w-44 shrink-0 items-center rounded-md ' +
                (active ? 'bg-current/[7.8%]' : 'hover:bg-current/5')
              }
              key={tab.id}
            >
              <button
                aria-controls={AUXILIARY_TABPANEL_ID}
                aria-selected={active}
                className="flex min-w-0 items-center gap-1.5 py-1 pl-2 pr-1"
                id={auxiliaryBrowserTabId(tab.id)}
                onClick={() => {
                  actions.selectTab(tab.id)
                }}
                role="tab"
                tabIndex={active ? 0 : -1}
                title={tab.url ?? tab.title}
                type="button"
              >
                <BrowserTabIcon tab={tab} />
                <span className="min-w-0 truncate text-xs">{tab.title}</span>
              </button>
              <button
                aria-label="关闭标签页"
                className="mr-1 rounded p-0.5 opacity-0 hover:bg-current/10 group-hover:opacity-60 hover:opacity-100"
                onClick={() => {
                  actions.closeTab(tab.id)
                }}
                type="button"
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
          )
        })}
      </div>

      <AuxiliaryNewTabMenu
        offers={paneOffers}
        onOpenChange={(next) => {
          onMenuChange(next ? 'new-tab' : null)
        }}
        onOpenPane={onOpenPane}
        open={openMenu === 'new-tab'}
      />

      <AuxiliaryTabsMenu
        focus={focus}
        host={host}
        onOpenChange={(next) => {
          onMenuChange(next ? 'tabs' : null)
        }}
        onReopenClosed={actions.reopenClosed}
        onSelectPane={onSelectPane}
        onSelectTab={actions.selectTab}
        open={openMenu === 'tabs'}
        panes={panes}
      />

      {/* 行尾角位。px-1 + mr-1.5 = 右距 10px，与宿主页头的 --cp-inset 一致。 */}
      {trailing ? <div className="mr-1.5 shrink-0">{trailing}</div> : null}
    </div>
  )
}
