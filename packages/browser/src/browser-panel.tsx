import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  MoreHorizontal,
  RotateCw,
  Wrench,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { BROWSER_PANEL, type BrowserPanelStore } from './browser-panel-store'
import type { BrowserTabView } from './browser-port'
import { BrowserTabStrip } from './browser-tab-strip'

/*
 * 浏览器面板（图一）。
 *
 * 页面本体不在这棵 React 树里：它是主窗口的原生子 webview，按逻辑坐标摆在
 * 下方视口区域上。这个组件只画「面板的壳」—— 标签条、工具栏、空态 ——
 * 并把视口矩形对齐给宿主。
 */

export interface BrowserPanelProps {
  readonly store: BrowserPanelStore
}

export function BrowserPanel({ store }: BrowserPanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const host = state.host
  const activeTab = host?.tabs.find((tab) => tab.id === host.activeTabId) ?? null

  return (
    <aside
      aria-label="浏览器"
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-current/10"
      style={{ width: state.width }}
    >
      <ResizeHandle store={store} width={state.width} />

      {host === null ? (
        /* 快照还没到（启动瞬间）或宿主没接上：如实说，不画一个假浏览器。 */
        <p className="p-4 text-xs opacity-50">浏览器宿主没有回应。</p>
      ) : (
        <>
          <BrowserTabStrip actions={store.actions} host={host} />
          <BrowserToolbar actions={store.actions} activeTab={activeTab} />
          <Viewport showEmpty={activeTab === null || activeTab.url === null} store={store} />
        </>
      )}
    </aside>
  )
}

function ResizeHandle({ store, width }: { store: BrowserPanelStore; width: number }) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  return (
    /* 拖拽宽度。松手那一次由 setResizing(false) 收尾落盘，与侧栏同款。 */
    <hr
      aria-label="调整浏览器面板宽度"
      aria-orientation="vertical"
      aria-valuemax={BROWSER_PANEL.maxWidth}
      aria-valuemin={BROWSER_PANEL.minWidth}
      aria-valuenow={width}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize border-0"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          store.setPanelWidth(width + 10)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          store.setPanelWidth(width - 10)
        }
      }}
      onPointerDown={(event) => {
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
        event.currentTarget.setPointerCapture(event.pointerId)
        store.setResizing(true)
      }}
      onPointerMove={(event) => {
        const current = drag.current

        if (current === null || current.pointerId !== event.pointerId) {
          return
        }

        store.setPanelWidth(current.startWidth + (current.startX - event.clientX))
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) {
          return
        }

        drag.current = null
        store.setResizing(false)
      }}
      tabIndex={0}
    />
  )
}

interface BrowserToolbarProps {
  readonly activeTab: BrowserTabView | null
  readonly actions: BrowserPanelStore['actions']
}

function BrowserToolbar({ activeTab, actions }: BrowserToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const canDrive = activeTab !== null && activeTab.url !== null

  return (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-current/10 px-2">
      <ToolbarButton
        disabled={!canDrive}
        label="后退"
        onClick={() => {
          if (activeTab !== null) {
            actions.back(activeTab.id)
          }
        }}
      >
        <ArrowLeft aria-hidden className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        disabled={!canDrive}
        label="前进"
        onClick={() => {
          if (activeTab !== null) {
            actions.forward(activeTab.id)
          }
        }}
      >
        <ArrowRight aria-hidden className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        disabled={!canDrive}
        label="刷新"
        onClick={() => {
          if (activeTab !== null) {
            actions.reload(activeTab.id)
          }
        }}
      >
        <RotateCw aria-hidden className="size-4" />
      </ToolbarButton>

      <AddressInput actions={actions} activeTab={activeTab} />

      <ToolbarButton
        label="更多操作"
        onClick={() => {
          setMenuOpen((open) => !open)
        }}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </ToolbarButton>

      {menuOpen ? (
        <OverflowMenu
          actions={actions}
          activeTab={activeTab}
          onDismiss={() => {
            setMenuOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function AddressInput({ activeTab, actions }: BrowserToolbarProps) {
  const committed = activeTab?.url ?? ''
  const [draft, setDraft] = useState(committed)
  const editing = useRef(false)

  /* 外部导航（点链接、重定向）要回到地址栏，但不打断正在输入的人。 */
  useEffect(() => {
    if (!editing.current) {
      setDraft(committed)
    }
  }, [committed])

  return (
    <input
      aria-label="地址栏"
      className="h-7 min-w-0 flex-1 rounded-md border border-current/10 bg-transparent px-2.5 text-xs outline-none placeholder:opacity-50 focus:border-current/25"
      onBlur={() => {
        editing.current = false
        setDraft(committed)
      }}
      onChange={(event) => {
        setDraft(event.target.value)
      }}
      onFocus={(event) => {
        editing.current = true
        event.currentTarget.select()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') {
          return
        }

        const address = draft.trim()

        if (address === '') {
          return
        }

        /* 没有标签就先开一个再导航 —— 宿主的 open 命令本来就收地址。 */
        if (activeTab === null) {
          actions.openTab(address)
        } else {
          actions.navigate(activeTab.id, address)
        }

        event.currentTarget.blur()
      }}
      placeholder="输入网址后回车"
      spellCheck={false}
      value={draft}
    />
  )
}

interface OverflowMenuProps extends BrowserToolbarProps {
  readonly onDismiss: () => void
}

/* 图三的「…」菜单：两项，禁用态跟着「有没有真的页面」走。 */
function OverflowMenu({ activeTab, actions, onDismiss }: OverflowMenuProps) {
  const url = activeTab?.url ?? null

  return (
    <>
      <button
        aria-label="关闭菜单"
        className="fixed inset-0 z-[var(--ui-z-popover)] cursor-default"
        onClick={onDismiss}
        type="button"
      />
      <div className="absolute right-2 top-full z-[var(--ui-z-popover)] mt-1 w-56 rounded-lg border border-current/10 bg-[Canvas] p-1 shadow-[var(--ui-shadow-xl)]">
        <MenuItem
          disabled={url === null}
          icon={<ExternalLink aria-hidden className="size-3.5" />}
          onClick={() => {
            if (url !== null) {
              actions.openExternal(url)
            }

            onDismiss()
          }}
        >
          在默认浏览器中打开
        </MenuItem>
        <MenuItem
          disabled={url === null}
          icon={<Wrench aria-hidden className="size-3.5" />}
          onClick={() => {
            if (activeTab !== null) {
              actions.openDevtools(activeTab.id)
            }

            onDismiss()
          }}
        >
          打开调试工具
        </MenuItem>
      </div>
    </>
  )
}

function MenuItem({
  children,
  disabled,
  icon,
  onClick,
}: {
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly icon: ReactNode
  readonly onClick: () => void
}) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs enabled:hover:bg-current/5 disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      {children}
    </button>
  )
}

function ToolbarButton({
  children,
  disabled,
  label,
  onClick,
}: {
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-md opacity-70 enabled:hover:bg-current/10 enabled:hover:opacity-100 disabled:opacity-30"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function Viewport({
  showEmpty,
  store,
}: {
  readonly showEmpty: boolean
  readonly store: BrowserPanelStore
}) {
  const region = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = region.current

    if (element === null) {
      return undefined
    }

    /*
     * 原生子 webview 不在 DOM 里，它按窗口逻辑坐标摆放。这里把视口矩形对齐
     * 过去：rAF 循环 + 变更检测，而不是 ResizeObserver —— 矩形「位置」的
     * 变化（侧栏开合、拖宽、窗口尺寸）不触发 RO，而这些变化必须当帧跟上，
     * 否则页面浮在错位上。有变化才发 IPC，静止时每帧只做四次数字比较。
     */
    let frame = 0
    let last = { x: -1, y: -1, width: -1, height: -1 }

    const align = () => {
      const rect = element.getBoundingClientRect()

      if (
        rect.x !== last.x ||
        rect.y !== last.y ||
        rect.width !== last.width ||
        rect.height !== last.height
      ) {
        last = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        store.reportViewport(last)
      }

      frame = requestAnimationFrame(align)
    }

    frame = requestAnimationFrame(align)

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [store])

  return (
    <div className="relative min-h-0 flex-1" ref={region}>
      {showEmpty ? (
        /* 图一的空态。活动标签是空白页时原生侧没有 webview，这里就是画面本身。 */
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Globe aria-hidden className="size-8 opacity-30" />
          <p className="text-sm font-medium">浏览器</p>
          <p className="text-xs opacity-50">粘贴或输入 URL 以打开网页。</p>
        </div>
      ) : null}
    </div>
  )
}
