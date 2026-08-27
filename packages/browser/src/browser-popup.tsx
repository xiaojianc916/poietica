import { warn } from '@poietica/core'
import { popupSurfaceClassName } from '@poietica/ui'
import { Globe, LoaderCircle, MessagesSquare, Search, X } from 'lucide-react'
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useMemo, useState } from 'react'

import type {
  BrowserHostPort,
  BrowserHostView,
  BrowserPopupAction,
  BrowserPopupRequest,
  BrowserTabView,
  BrowserViewportRect,
} from './browser-port'

const TAB_ROW = 32
const MENU_ROW = 40
const POPUP_MARGIN = 8
const POPUP_CHROME = 24
const MENU_DIVIDER = 9
const SEARCH_ROW = 44
const GROUP_LABEL = 24
const TABS_MAX_HEIGHT = 384
const GAP = 4

export function browserPopupSize(
  request: Omit<BrowserPopupRequest, 'theme'>,
  host: BrowserHostView,
): { readonly width: number; readonly height: number } {
  if (request.kind === 'overflow') {
    return {
      width: 360 + POPUP_MARGIN * 2,
      height: MENU_ROW * 3 + MENU_DIVIDER + POPUP_CHROME,
    }
  }

  const groups = host.recentlyClosed.length > 0 ? 2 : 1
  const openRows = Math.max(request.panes.length + host.tabs.length, 1)
  const rows = openRows + host.recentlyClosed.length
  const natural = SEARCH_ROW + groups * GROUP_LABEL + rows * TAB_ROW + POPUP_CHROME

  return { width: 352, height: Math.min(natural, TABS_MAX_HEIGHT) }
}

export function requestBrowserPopup(
  open: (request: BrowserPopupRequest, rect: BrowserViewportRect) => void,
  request: Omit<BrowserPopupRequest, 'theme'>,
  host: BrowserHostView,
  trigger: HTMLElement,
): void {
  const bounds = trigger.getBoundingClientRect()
  const size = browserPopupSize(request, host)

  open(
    {
      ...request,
      theme: document.documentElement.dataset['theme'] ?? 'light',
    },
    {
      x: Math.max(bounds.right - size.width + POPUP_MARGIN, -POPUP_MARGIN),
      y: Math.max(bounds.bottom + GAP - POPUP_MARGIN, -POPUP_MARGIN),
      width: size.width,
      height: size.height,
    },
  )
}

interface FaceProps {
  readonly host: BrowserHostView
  readonly request: BrowserPopupRequest
  readonly port: BrowserHostPort
  readonly onDismiss: () => void
  readonly onAction: (action: BrowserPopupAction) => Promise<void>
}

export type BrowserPopupSurfaceProps = FaceProps

function run(operation: string, task: () => Promise<void>, after?: () => void): void {
  void task()
    .catch((cause: unknown) => {
      warn(`浏览器浮层操作失败：${operation}`, { scope: 'browser-popup', cause })
    })
    .finally(after)
}

function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    return
  }

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    ),
  )
  if (items.length === 0) {
    return
  }

  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  let next = 0

  if (event.key === 'End') {
    next = items.length - 1
  } else if (event.key === 'ArrowUp') {
    next = current <= 0 ? items.length - 1 : current - 1
  } else if (event.key === 'ArrowDown') {
    next = current >= items.length - 1 ? 0 : current + 1
  }

  items[next]?.focus()
}

export function BrowserPopupSurface({ request, ...face }: BrowserPopupSurfaceProps) {
  const overflow = request.kind === 'overflow'

  return (
    <div
      aria-label={overflow ? '更多操作' : '标签页列表'}
      className={`${popupSurfaceClassName} flex h-full flex-col p-1 text-sm`}
      onKeyDown={overflow ? moveMenuFocus : undefined}
      role={overflow ? 'menu' : 'dialog'}
    >
      {overflow ? (
        <OverflowFace {...face} request={request} />
      ) : (
        <TabsFace {...face} request={request} />
      )}
    </div>
  )
}

function MenuRow({
  autoFocus = false,
  children,
  disabled = false,
  onSelect,
}: {
  readonly autoFocus?: boolean
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly onSelect: () => void
}) {
  return (
    <button
      className="flex h-10 w-full shrink-0 items-center rounded-md px-4 text-left enabled:hover:bg-current/10 disabled:opacity-40"
      disabled={disabled}
      onClick={onSelect}
      role="menuitem"
      type="button"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

function MenuDivider() {
  return <div className="mx-3 my-1 h-px shrink-0 bg-current/10" role="separator" />
}

function OverflowFace({ host, port, onDismiss }: FaceProps) {
  const tab = host.tabs.find((candidate) => candidate.id === host.activeTabId) ?? null
  const url = tab?.url ?? null

  return (
    <>
      <MenuRow
        autoFocus={url !== null}
        disabled={url === null}
        onSelect={() => {
          if (tab !== null) {
            run('print', () => port.print(tab.id), onDismiss)
          }
        }}
      >
        打印
      </MenuRow>
      <MenuDivider />
      <MenuRow
        disabled={url === null}
        onSelect={() => {
          if (url !== null) {
            run('open-external', () => port.openExternal(url), onDismiss)
          }
        }}
      >
        在默认浏览器中打开
      </MenuRow>
      <MenuRow
        disabled={url === null || tab === null}
        onSelect={() => {
          if (tab !== null) {
            run('open-devtools', () => port.openDevtools(tab.id), onDismiss)
          }
        }}
      >
        打开调试工具
      </MenuRow>
    </>
  )
}

function matches(title: string, url: string | null, needle: string): boolean {
  if (needle === '') {
    return true
  }
  return title.toLowerCase().includes(needle) || (url?.toLowerCase().includes(needle) ?? false)
}

function TabsFace({ host, request, port, onDismiss, onAction }: FaceProps) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const panes = useMemo(
    () => request.panes.filter((pane) => matches(pane.title, null, needle)),
    [request.panes, needle],
  )
  const openTabs = useMemo(
    () => host.tabs.filter((tab) => matches(tab.title, tab.url, needle)),
    [host.tabs, needle],
  )
  const closedTabs = useMemo(
    () =>
      host.recentlyClosed
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => matches(entry.title, entry.url, needle)),
    [host.recentlyClosed, needle],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-1 flex shrink-0 items-center gap-2 rounded-md border border-divider px-2 py-1.5">
        <Search aria-hidden className="size-3.5 shrink-0 opacity-50" />
        <input
          aria-label="搜索标签页"
          className="w-full bg-transparent text-xs outline-none placeholder:opacity-50"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标签页…"
          value={query}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-3 pb-1 pt-2 text-[11px] opacity-50">打开的标签页</p>
        {panes.map((pane) => (
          <div
            className={
              'group flex items-center rounded-md ' +
              (request.activePaneId === pane.id ? 'bg-current/10' : 'hover:bg-current/10')
            }
            key={pane.id}
          >
            <button
              className="flex h-8 min-w-0 flex-1 items-center gap-2 px-3"
              onClick={() =>
                run(
                  'select-pane',
                  () =>
                    onAction({
                      action: 'select-pane',
                      paneId: pane.id,
                      tabId: null,
                      index: null,
                    }),
                  onDismiss,
                )
              }
              type="button"
            >
              <MessagesSquare aria-hidden className="size-3.5 shrink-0 opacity-60" />
              <span className="min-w-0 truncate text-xs">{pane.title}</span>
            </button>
            <button
              aria-label="关闭标签页"
              className="mr-1 rounded p-0.5 opacity-0 hover:bg-current/10 group-hover:opacity-60 hover:opacity-100"
              onClick={() =>
                run(
                  'close-pane',
                  () =>
                    onAction({
                      action: 'close-pane',
                      paneId: pane.id,
                      tabId: null,
                      index: null,
                    }),
                  onDismiss,
                )
              }
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        ))}

        {openTabs.map((tab) => {
          const active = request.activePaneId === null && tab.id === host.activeTabId
          return (
            <div
              className={
                'group flex items-center rounded-md ' +
                (active ? 'bg-current/10' : 'hover:bg-current/10')
              }
              key={tab.id}
            >
              <button
                className="flex h-8 min-w-0 flex-1 items-center gap-2 px-3"
                onClick={() =>
                  run(
                    'select-tab',
                    () =>
                      onAction({
                        action: 'select-tab',
                        paneId: null,
                        tabId: tab.id,
                        index: null,
                      }),
                    onDismiss,
                  )
                }
                type="button"
              >
                <TabIcon tab={tab} />
                <span className="min-w-0 truncate text-xs">{tab.title}</span>
              </button>
              <button
                aria-label="关闭标签页"
                className="mr-1 rounded p-0.5 opacity-0 hover:bg-current/10 group-hover:opacity-60 hover:opacity-100"
                onClick={() =>
                  run('close-tab', () =>
                    onAction({
                      action: 'close-tab',
                      paneId: null,
                      tabId: tab.id,
                      index: null,
                    }),
                  )
                }
                type="button"
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
          )
        })}

        {panes.length + openTabs.length === 0 ? (
          <p className="px-3 py-1.5 text-xs opacity-50">没有匹配的标签页</p>
        ) : null}

        {closedTabs.length > 0 ? (
          <>
            <p className="px-3 pb-1 pt-2 text-[11px] opacity-50">最近关闭的标签页</p>
            {closedTabs.map(({ entry, index }) => (
              <button
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-3 hover:bg-current/10"
                key={entry.url + String(index)}
                onClick={() =>
                  run(
                    'reopen-closed',
                    () =>
                      onAction({
                        action: 'reopen-closed',
                        paneId: null,
                        tabId: null,
                        index,
                      }),
                    onDismiss,
                  )
                }
                type="button"
              >
                <Globe aria-hidden className="size-3.5 shrink-0 opacity-40" />
                <span className="min-w-0 truncate text-xs opacity-70">{entry.title}</span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    </div>
  )
}

function TabIcon({ tab }: { readonly tab: BrowserTabView }) {
  if (tab.loading) {
    return <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin opacity-60" />
  }
  if (tab.favicon === null) {
    return <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
  }
  return <img alt="" className="size-3.5 shrink-0 rounded-sm" src={tab.favicon} />
}
