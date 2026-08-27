import { popupSurfaceClassName } from '@poietica/ui'
import { Globe, LoaderCircle, Search, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import type {
  BrowserHostPort,
  BrowserHostView,
  BrowserPopupKind,
  BrowserTabView,
  BrowserViewportRect,
} from './browser-port'

/*
 * 浮层的两张面。
 *
 * 它们画在 browser-popup 窗口里 —— 页面是主窗口的原生子 webview，主窗口的 HTML
 * 盖不过它。这个包不认识窗口：宿主给快照与端口，浮层只画和调。
 */

const ROW = 32
const FRAME = 10
const SEARCH_ROW = 44
const GROUP_LABEL = 24
const TABS_MAX_HEIGHT = 360
const GAP = 4

/** 窗口尺寸由内容算出，算法只有这一份：宿主照它开窗，浮层照它铺满。 */
export function browserPopupSize(
  kind: BrowserPopupKind,
  host: BrowserHostView,
): { readonly width: number; readonly height: number } {
  if (kind === 'overflow') {
    return { width: 300, height: 2 * ROW + FRAME }
  }

  const groups = host.recentlyClosed.length > 0 ? 2 : 1
  const rows = Math.max(host.tabs.length, 1) + host.recentlyClosed.length
  const natural = SEARCH_ROW + groups * GROUP_LABEL + rows * ROW + FRAME

  return { width: 320, height: Math.min(natural, TABS_MAX_HEIGHT) }
}

/** 从触发按钮算出浮层窗口的位置，并请宿主开窗。锚点算法只有这一份。 */
export function requestBrowserPopup(
  open: (kind: BrowserPopupKind, theme: string, rect: BrowserViewportRect) => void,
  kind: BrowserPopupKind,
  host: BrowserHostView,
  trigger: HTMLElement,
): void {
  const bounds = trigger.getBoundingClientRect()
  const size = browserPopupSize(kind, host)

  open(kind, document.documentElement.dataset['theme'] ?? 'light', {
    x: Math.max(bounds.right - size.width, 0),
    y: bounds.bottom + GAP,
    width: size.width,
    height: size.height,
  })
}

interface FaceProps {
  readonly host: BrowserHostView
  readonly port: BrowserHostPort
  readonly onDismiss: () => void
}

export interface BrowserPopupSurfaceProps extends FaceProps {
  readonly kind: BrowserPopupKind
}

export function BrowserPopupSurface({ kind, ...face }: BrowserPopupSurfaceProps) {
  return (
    <div className={`${popupSurfaceClassName} flex h-full flex-col p-1 text-[13px]`}>
      {kind === 'overflow' ? <OverflowFace {...face} /> : <TabsFace {...face} />}
    </div>
  )
}

/* 行的形状照图二：无字形、单行、32px、圆角 4px，禁用态只降不透明度。 */
function MenuRow({
  children,
  disabled = false,
  onSelect,
}: {
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly onSelect: () => void
}) {
  return (
    <button
      className="flex h-8 w-full shrink-0 items-center rounded-[4px] px-3 text-left enabled:hover:bg-current/10 disabled:opacity-40"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

/* 「…」菜单：禁用态跟着「有没有真的页面」走。 */
function OverflowFace({ host, port, onDismiss }: FaceProps) {
  const tab = host.tabs.find((candidate) => candidate.id === host.activeTabId) ?? null
  const url = tab?.url ?? null

  return (
    <>
      <MenuRow
        disabled={url === null}
        onSelect={() => {
          if (url !== null) {
            void port.openExternal(url)
          }

          onDismiss()
        }}
      >
        在默认浏览器中打开
      </MenuRow>
      <MenuRow
        disabled={tab === null}
        onSelect={() => {
          if (tab !== null) {
            void port.openDevtools(tab.id)
          }

          onDismiss()
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

function TabsFace({ host, port, onDismiss }: FaceProps) {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-1 flex shrink-0 items-center gap-2 rounded-md border border-divider px-2 py-1.5">
        <Search aria-hidden className="size-3.5 shrink-0 opacity-50" />
        <input
          aria-label="搜索标签页"
          autoFocus
          className="w-full bg-transparent text-xs outline-none placeholder:opacity-50"
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          placeholder="搜索标签页…"
          value={query}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-3 pb-1 pt-2 text-[11px] opacity-50">打开的标签页</p>
        {openTabs.map((tab) => (
          <div className="group flex items-center rounded-[4px] hover:bg-current/10" key={tab.id}>
            <button
              className="flex h-8 min-w-0 flex-1 items-center gap-2 px-3"
              onClick={() => {
                void port.selectTab(tab.id)
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
                void port.closeTab(tab.id)
              }}
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        ))}
        {openTabs.length === 0 ? (
          <p className="px-3 py-1.5 text-xs opacity-50">没有匹配的标签页</p>
        ) : null}

        {closedTabs.length > 0 ? (
          <>
            <p className="px-3 pb-1 pt-2 text-[11px] opacity-50">最近关闭的标签页</p>
            {closedTabs.map(({ entry, index }) => (
              <button
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-[4px] px-3 hover:bg-current/10"
                key={entry.url + String(index)}
                onClick={() => {
                  void port.reopenClosed(index)
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
    </div>
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
