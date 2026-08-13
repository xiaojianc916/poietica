import { ChevronDown, Globe, LoaderCircle, Plus, Search, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import type { BrowserPanelStore } from './browser-panel-store'
import type { BrowserHostView } from './browser-port'

/*
 * 标签条与标签下拉（图一顶行 + 图四）。
 *
 * 这里没有状态可拥有：标签是宿主的，开合是本组件的一个布尔。行点击即切换、
 * 行内的 X 即关闭，与主流浏览器同构。
 */

interface BrowserTabStripProps {
  readonly host: BrowserHostView
  readonly actions: BrowserPanelStore['actions']
  /** 行尾角位：宿主放面板开关。 */
  readonly trailing?: ReactNode
}

export function BrowserTabStrip({ host, actions, trailing }: BrowserTabStripProps) {
  const [listOpen, setListOpen] = useState(false)

  return (
    /* 行高与宿主页头一致（32px）：角位上的开关在开合两态间零位移。 */
    <div className="relative flex h-8 shrink-0 items-center gap-1 border-b border-current/10 px-1">
      <button
        aria-expanded={listOpen}
        aria-label="标签页列表"
        className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100"
        onClick={() => {
          setListOpen((open) => !open)
        }}
        type="button"
      >
        <ChevronDown aria-hidden className="size-4" />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {host.tabs.map((tab) => {
          const active = tab.id === host.activeTabId

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
                {tab.loading ? (
                  <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin opacity-60" />
                ) : (
                  <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
                )}
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

      {/* 行尾角位。px-1 + mr-1.5 = 右距 10px，与宿主页头的 --cp-inset 一致。 */}
      {trailing ? <div className="mr-1.5 shrink-0">{trailing}</div> : null}

      {listOpen ? (
        <BrowserTabList
          actions={actions}
          host={host}
          onDismiss={() => {
            setListOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function matches(title: string, url: string | null, needle: string): boolean {
  if (needle === '') {
    return true
  }

  return title.toLowerCase().includes(needle) || (url?.toLowerCase().includes(needle) ?? false)
}

interface BrowserTabListProps extends BrowserTabStripProps {
  readonly onDismiss: () => void
}

function BrowserTabList({ host, actions, onDismiss }: BrowserTabListProps) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

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
    <>
      <button
        aria-label="关闭标签页列表"
        className="fixed inset-0 z-[var(--ui-z-popover)] cursor-default"
        onClick={onDismiss}
        type="button"
      />
      <div className="absolute left-1 top-full z-[var(--ui-z-popover)] mt-1 w-72 rounded-lg border border-current/10 bg-[Canvas] p-1 shadow-[var(--ui-shadow-xl)]">
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
              {tab.loading ? (
                <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin opacity-60" />
              ) : (
                <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
              )}
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
        {openTabs.length === 0 ? (
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
    </>
  )
}
