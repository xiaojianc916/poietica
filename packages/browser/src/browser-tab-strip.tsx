import { ChevronDown, Globe, LoaderCircle, Plus, Search, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import type { BrowserPanelStore } from './browser-panel-store'
import type { BrowserHostView, BrowserTabView } from './browser-port'

/*
 * 标签条与标签下拉。
 *
 * 一格通道与一个宿主标签在这里是同一种行：同样的选中态、同样的关闭键，也同样进
 * 下拉里的那一份清单 —— 清单只有一份，两个出口读的是同一批行。
 *
 * 下拉在流内展开，不是压在视口上的浮层：原生子 webview 是独立窗口，永远盖过主窗口
 * 的 HTML，浮在它上面的东西看不见。让位的办法是收窄它的矩形，不是让整块网页消失。
 */

interface BrowserTabStripProps {
  readonly host: BrowserHostView
  readonly actions: BrowserPanelStore['actions']
  readonly paneIds: readonly string[]
  readonly activePaneId: string | null
  readonly paneIcon: ReactNode
  readonly paneName: (id: string) => string
  readonly onSelectPane: (id: string | null) => void
  readonly onClosePane: (id: string) => void
  /** 行尾角位：宿主放面板开关。 */
  readonly trailing?: ReactNode
}

export function BrowserTabStrip({
  host,
  actions,
  activePaneId,
  paneIcon,
  paneIds,
  paneName,
  onClosePane,
  onSelectPane,
  trailing,
}: BrowserTabStripProps) {
  const [listOpen, setListOpen] = useState(false)

  return (
    <>
      {/* 行高与宿主页头一致（32px）：角位上的开关在开合两态间零位移。 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-current/10 px-1">
        {/* 原生横向滚动条占布局高度，会把 24px 的标签顶出 32px 的行；内联藏掉，
            不走类扫描与构建链。溢出导航：触控板横滑、Shift+滚轮、左端标签列表。 */}
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          style={{ scrollbarWidth: 'none' }}
        >
          {paneIds.map((id) => (
            <div
              className={
                'group flex max-w-44 shrink-0 items-center rounded-md ' +
                (id === activePaneId ? 'bg-current/10' : 'hover:bg-current/5')
              }
              key={id}
            >
              <button
                className="flex min-w-0 items-center gap-1.5 py-1 pl-2 pr-1"
                onClick={() => {
                  onSelectPane(id)
                }}
                title={paneName(id)}
                type="button"
              >
                {paneIcon}
                <span className="min-w-0 truncate text-xs">{paneName(id)}</span>
              </button>
              <button
                aria-label="关闭标签页"
                className="mr-1 rounded p-0.5 opacity-0 hover:bg-current/10 group-hover:opacity-60 hover:opacity-100"
                onClick={() => {
                  onClosePane(id)
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
          aria-label="新建标签页"
          className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100"
          onClick={() => {
            actions.openTab(null)
          }}
          type="button"
        >
          <Plus aria-hidden className="size-4" />
        </button>

        <button
          aria-expanded={listOpen}
          aria-label="标签页列表"
          className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 aria-expanded:bg-current/10 aria-expanded:opacity-100 hover:bg-current/10 hover:opacity-100"
          onClick={() => {
            setListOpen((open) => !open)
          }}
          type="button"
        >
          <ChevronDown aria-hidden className="size-4" />
        </button>

        {/* 行尾角位。px-1 + mr-1.5 = 右距 10px，与宿主页头的 --cp-inset 一致。 */}
        {trailing ? <div className="mr-1.5 shrink-0">{trailing}</div> : null}
      </div>

      {listOpen ? (
        <BrowserTabList
          actions={actions}
          host={host}
          onClosePane={onClosePane}
          onDismiss={() => {
            setListOpen(false)
          }}
          onSelectPane={onSelectPane}
          paneIcon={paneIcon}
          paneIds={paneIds}
          paneName={paneName}
        />
      ) : null}
    </>
  )
}

/* 标签的脸：装载中转圈，有站点图标就画它，否则地球。 */
function TabIcon({ tab }: { readonly tab: BrowserTabView }) {
  if (tab.loading) {
    return <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin opacity-60" />
  }

  if (tab.favicon === null) {
    return <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
  }

  return <img alt="" className="size-3.5 shrink-0 rounded-sm" src={tab.favicon} />
}

function matches(title: string, url: string | null, needle: string): boolean {
  if (needle === '') {
    return true
  }

  return title.toLowerCase().includes(needle) || (url?.toLowerCase().includes(needle) ?? false)
}

interface BrowserTabListProps {
  readonly host: BrowserHostView
  readonly actions: BrowserPanelStore['actions']
  readonly paneIds: readonly string[]
  readonly paneIcon: ReactNode
  readonly paneName: (id: string) => string
  readonly onSelectPane: (id: string | null) => void
  readonly onClosePane: (id: string) => void
  readonly onDismiss: () => void
}

function BrowserTabList({
  host,
  actions,
  paneIcon,
  paneIds,
  paneName,
  onClosePane,
  onSelectPane,
  onDismiss,
}: BrowserTabListProps) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  /* 与标签条同序：通道在前，宿主标签在后。 */
  const openPanes = useMemo(
    () => paneIds.filter((id) => matches(paneName(id), null, needle)),
    [needle, paneIds, paneName],
  )

  const openTabs = useMemo(
    () => host.tabs.filter((tab) => matches(tab.title, tab.url, needle)),
    [host.tabs, needle],
  )

  /* 环里的序号就是宿主 reopen 的地址，过滤前先钉住，过滤后不重算。 */
  const closedTabs = useMemo(
    () =>
      host.recentlyClosed
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => matches(entry.title, entry.url, needle)),
    [host.recentlyClosed, needle],
  )

  return (
    <div className="max-h-64 shrink-0 overflow-y-auto border-b border-current/10 p-1">
      <div className="flex items-center gap-2 rounded-md border border-current/10 px-2 py-1.5">
        <Search aria-hidden className="size-3.5 shrink-0 opacity-50" />
        <input
          aria-label="搜索标签页"
          className="w-full bg-transparent text-xs outline-none placeholder:opacity-50"
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          placeholder="搜索标签页…"
          value={query}
        />
      </div>

      <p className="px-2 pb-1 pt-2 text-[11px] opacity-50">打开的标签页</p>
      {openPanes.map((id) => (
        <div className="group flex items-center rounded-md hover:bg-current/5" key={id}>
          <button
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
            onClick={() => {
              onSelectPane(id)
              onDismiss()
            }}
            type="button"
          >
            {paneIcon}
            <span className="min-w-0 truncate text-xs">{paneName(id)}</span>
          </button>
          <button
            aria-label="关闭标签页"
            className="mr-1 rounded p-0.5 opacity-0 hover:bg-current/10 group-hover:opacity-60 hover:opacity-100"
            onClick={() => {
              onClosePane(id)
            }}
            type="button"
          >
            <X aria-hidden className="size-3" />
          </button>
        </div>
      ))}
      {openTabs.map((tab) => (
        <div className="group flex items-center rounded-md hover:bg-current/5" key={tab.id}>
          <button
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
            onClick={() => {
              actions.selectTab(tab.id)
              onDismiss()
            }}
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
      ))}
      {openPanes.length + openTabs.length === 0 ? (
        <p className="px-2 py-1.5 text-xs opacity-50">没有匹配的标签页</p>
      ) : null}

      {closedTabs.length > 0 ? (
        <>
          <p className="px-2 pb-1 pt-2 text-[11px] opacity-50">最近关闭的标签页</p>
          {closedTabs.map(({ entry, index }) => (
            <button
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-current/5"
              key={entry.url + String(index)}
              onClick={() => {
                actions.reopenClosed(index)
                onDismiss()
              }}
              type="button"
            >
              <Globe aria-hidden className="size-3.5 shrink-0 opacity-40" />
              <span className="min-w-0 truncate text-xs opacity-70">{entry.title}</span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  )
}
