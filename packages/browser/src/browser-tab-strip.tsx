import { ChevronDown, Globe, LoaderCircle, Plus, X } from 'lucide-react'
import type { ReactNode } from 'react'

import type { BrowserPanelStore } from './browser-panel-store'
import { requestBrowserPopup } from './browser-popup'
import type { BrowserPopupRequest, BrowserState, BrowserTab } from './browser-port'

/*
 * 标签条与标签下拉。
 *
 * 一格通道与一个宿主标签在这里是同一种行：同样的选中态、同样的关闭键，也同样进
 * 下拉里的那一份清单 —— 清单只有一份，两个出口读的是同一批行。
 *
 * 标签下拉画在 browser-popup 窗口里：原生子 webview 永远盖过主窗口的 HTML，
 * 浮层只能是另一个原生窗口。
 */

/** 标签行上一格通道的样子。 */
export interface DockPaneView {
  readonly id: string
  readonly name: string
  readonly icon: ReactNode
}

/** 加号菜单里可开的通道种类。形状取自原生契约，不另声明一份。 */
export type DockPaneOffer = BrowserPopupRequest['paneKinds'][number]

interface BrowserTabStripProps {
  readonly host: BrowserState
  readonly actions: BrowserPanelStore['actions']
  readonly panes: readonly DockPaneView[]
  readonly paneOffers: readonly DockPaneOffer[]
  readonly activePaneId: string | null
  readonly onSelectPane: (id: string | null) => void
  readonly onClosePane: (id: string) => void
  /** 行尾角位：宿主放面板开关。 */
  readonly trailing?: ReactNode
}

export function BrowserTabStrip({
  host,
  actions,
  activePaneId,
  paneOffers,
  panes,
  onClosePane,
  onSelectPane,
  trailing,
}: BrowserTabStripProps) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-current/10 px-1">
      {/* 行高与宿主页头一致（32px）：角位上的开关在开合两态间零位移。 */}
      {/* 原生横向滚动条占布局高度，会把 24px 的标签顶出 32px 的行；内联藏掉，
            不走类扫描与构建链。溢出导航：触控板横滑、Shift+滚轮、左端标签列表。 */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        {panes.map((pane) => (
          <div
            className={
              'group flex max-w-44 shrink-0 items-center rounded-md ' +
              (pane.id === activePaneId ? 'bg-current/10' : 'hover:bg-current/5')
            }
            key={pane.id}
          >
            <button
              className="flex min-w-0 items-center gap-1.5 py-1 pl-2 pr-1"
              onClick={() => {
                onSelectPane(pane.id)
              }}
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
        ))}
        {host.tabs.map((tab) => {
          const active = activePaneId === null && tab.id === host.activeTabId

          return (
            <div
              className={
                'group flex max-w-44 shrink-0 items-center rounded-md ' +
                (active ? 'bg-current/10' : 'hover:bg-current/5')
              }
              key={tab.id}
            >
              <button
                className="flex min-w-0 items-center gap-1.5 py-1 pl-2 pr-1"
                onClick={() => {
                  actions.selectTab(tab.id)
                }}
                title={tab.url ?? tab.title}
                type="button"
              >
                <TabIcon tab={tab} />
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

      <button
        aria-haspopup="menu"
        aria-label="新建标签页"
        className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100"
        onClick={(event) => {
          requestBrowserPopup(
            actions.openPopup,
            { activePaneId, kind: 'new-tab', paneKinds: [...paneOffers], panes: [] },
            host,
            event.currentTarget,
          )
        }}
        type="button"
      >
        <Plus aria-hidden className="size-4" />
      </button>

      <button
        aria-haspopup="menu"
        aria-label="标签页列表"
        className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100"
        onClick={(event) => {
          requestBrowserPopup(
            actions.openPopup,
            {
              activePaneId,
              kind: 'tabs',
              paneKinds: [],
              panes: panes.map((pane) => ({ id: pane.id, title: pane.name })),
            },
            host,
            event.currentTarget,
          )
        }}
        type="button"
      >
        <ChevronDown aria-hidden className="size-4" />
      </button>

      {/* 行尾角位。px-1 + mr-1.5 = 右距 10px，与宿主页头的 --cp-inset 一致。 */}
      {trailing ? <div className="mr-1.5 shrink-0">{trailing}</div> : null}
    </div>
  )
}

/* 标签的脸：装载中转圈，有站点图标就画它，否则地球。 */
function TabIcon({ tab }: { readonly tab: BrowserTab }) {
  if (tab.loading) {
    return <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin opacity-60" />
  }

  if (tab.favicon === null) {
    return <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
  }

  return <img alt="" className="size-3.5 shrink-0 rounded-sm" src={tab.favicon} />
}
