import { warn } from '@poietica/core'
import { popupSurfaceClassName } from '@poietica/ui'
import {
  ChevronRight,
  Globe,
  LoaderCircle,
  MessagesSquare,
  Minus,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type {
  BrowserHostPort,
  BrowserHostView,
  BrowserPopupAction,
  BrowserPopupRequest,
  BrowserTabView,
  BrowserViewportRect,
} from './browser-port'

const TAB_ROW = 32
const MENU_ROW = 32
const MENU_DIVIDER = 9
const MENU_WIDTH = 288
const SURFACE_PADDING = 4
const SEARCH_ROW = 44
const GROUP_LABEL = 24
const TABS_MAX_HEIGHT = 384
const TABS_WIDTH = 352
const GAP = 4

type OverflowRow =
  | { readonly kind: 'divider'; readonly id: string }
  | { readonly kind: 'zoom'; readonly id: string }
  | {
      readonly kind: 'command'
      readonly id: string
      readonly label: string
      readonly action?: 'print'
      readonly disabled?: true
      readonly submenu?: true
    }

/* 行清单是溢出菜单的唯一真相：窗口高度由它算出，加一行不用再改第二个数。 */
const OVERFLOW_ROWS: readonly OverflowRow[] = [
  { kind: 'command', id: 'find-in-page', label: '在页面中查找', disabled: true },
  { kind: 'command', id: 'print', label: '打印', action: 'print' },
  { kind: 'divider', id: 'after-print' },
  { kind: 'zoom', id: 'zoom' },
  { kind: 'divider', id: 'after-zoom' },
  { kind: 'command', id: 'device-toolbar', label: '显示设备工具栏', disabled: true },
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

export function browserPopupSize(
  request: Omit<BrowserPopupRequest, 'theme'>,
  host: BrowserHostView,
): { readonly width: number; readonly height: number } {
  if (request.kind === 'overflow') {
    const content = OVERFLOW_ROWS.reduce(
      (total, row) => total + (row.kind === 'divider' ? MENU_DIVIDER : MENU_ROW),
      0,
    )

    return {
      width: MENU_WIDTH,
      height: content + SURFACE_PADDING * 2,
    }
  }

  const groups = host.recentlyClosed.length > 0 ? 2 : 1
  const openRows = Math.max(request.panes.length + host.tabs.length, 1)
  const rows = openRows + host.recentlyClosed.length
  const natural = SEARCH_ROW + groups * GROUP_LABEL + rows * TAB_ROW + SURFACE_PADDING * 2

  return {
    width: TABS_WIDTH,
    height: Math.min(natural, TABS_MAX_HEIGHT),
  }
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
      x: Math.max(bounds.right - size.width, 0),
      y: bounds.bottom + GAP,
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
  const surface = useRef<HTMLDivElement>(null)

  /* 焦点先落进这张表面：窗口的"失焦即关闭"要成立，文档里必须真的有焦点。 */
  useEffect(() => {
    surface.current?.focus()
  }, [])

  return (
    <div
      aria-label={overflow ? '更多操作' : '标签页列表'}
      className={`${popupSurfaceClassName} flex h-full flex-col p-1 text-sm`}
      onKeyDown={overflow ? moveMenuFocus : undefined}
      ref={surface}
      role={overflow ? 'menu' : 'dialog'}
      tabIndex={-1}
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
  children,
  disabled = false,
  onSelect,
  submenu = false,
}: {
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly onSelect: () => void
  readonly submenu?: boolean
}) {
  return (
    <button
      className="flex w-full shrink-0 items-center gap-2 rounded-md px-3 text-left enabled:hover:bg-current/10 disabled:opacity-40"
      disabled={disabled}
      onClick={onSelect}
      role="menuitem"
      style={{ height: MENU_ROW }}
      type="button"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {submenu ? <ChevronRight aria-hidden className="size-4 shrink-0 opacity-50" /> : null}
    </button>
  )
}

function MenuDivider() {
  return (
    <div
      className="mx-2 shrink-0 bg-current/10"
      role="separator"
      style={{ height: 1, marginBottom: 4, marginTop: 4 }}
    />
  )
}

function ZoomStep({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <button
      aria-label={label}
      className="flex size-6 shrink-0 items-center justify-center rounded enabled:hover:bg-current/10 disabled:opacity-40"
      disabled
      type="button"
    >
      {children}
    </button>
  )
}

/* 缩放行不是命令，是一个读数加三个控件；内核缩放能力还没接，控件先立在这里。 */
function ZoomRow() {
  return (
    <div
      aria-label="缩放"
      className="flex w-full shrink-0 items-center gap-1 px-3"
      role="group"
      style={{ height: MENU_ROW }}
    >
      <span className="min-w-0 flex-1 truncate">缩放</span>
      <ZoomStep label="缩小">
        <Minus aria-hidden className="size-4" />
      </ZoomStep>
      <span className="w-10 shrink-0 text-center tabular-nums opacity-70">100%</span>
      <ZoomStep label="放大">
        <Plus aria-hidden className="size-4" />
      </ZoomStep>
      <ZoomStep label="重置缩放">
        <RotateCcw aria-hidden className="size-4" />
      </ZoomStep>
    </div>
  )
}

function OverflowFace({ host, port, onDismiss }: FaceProps) {
  const tab = host.tabs.find((candidate) => candidate.id === host.activeTabId) ?? null
  const printable = tab !== null && tab.url !== null

  return (
    <>
      {OVERFLOW_ROWS.map((row) => {
        if (row.kind === 'divider') {
          return <MenuDivider key={row.id} />
        }

        if (row.kind === 'zoom') {
          return <ZoomRow key={row.id} />
        }

        const prints = row.action === 'print'

        return (
          <MenuRow
            disabled={prints ? !printable : (row.disabled ?? false)}
            key={row.id}
            onSelect={() => {
              if (prints && tab !== null) {
                run('print', () => port.print(tab.id), onDismiss)
                return
              }

              onDismiss()
            }}
            submenu={row.submenu ?? false}
          >
            {row.label}
          </MenuRow>
        )
      })}
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
