import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  ExternalLink,
  Globe,
  MoreHorizontal,
  RotateCw,
  Wrench,
} from 'lucide-react'
import {
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

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
  /** 标签条行尾的角位：宿主放面板开关，几何与宿主页头对齐。 */
  readonly trailing?: ReactNode
}

export function BrowserPanel({ store, trailing }: BrowserPanelProps) {
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
        /*
         * 快照还没到（启动瞬间）或宿主没接上：如实说，不画一个假浏览器。
         * 角位照常在 —— 面板不能因为宿主哑了就收不起来。
         */
        <>
          <div className="flex h-8 items-center justify-end border-b border-current/10 pr-2.5">
            {trailing}
          </div>
          <p className="p-4 text-xs opacity-50">浏览器宿主没有回应。</p>
        </>
      ) : (
        <>
          <BrowserTabStrip actions={store.actions} host={host} trailing={trailing} />
          <BrowserToolbar actions={store.actions} activeTab={activeTab} />
          <Viewport showEmpty={activeTab === null || activeTab.url === null} store={store} />
        </>
      )}
    </aside>
  )
}

/*
 * 指针是否还在条上，按几何自己算。捕获期间浏览器的 :hover 按规范被覆盖到捕获
 * 元素上（Pointer Events L3 setPointerCapture），所以收尾态不能问浏览器。
 * 与 packages/workspace/src/shell/sidebar/use-sidebar-resize.ts 同款。
 */
function isPointerOver(element: HTMLHRElement, point: { x: number; y: number }): boolean {
  const rect = element.getBoundingClientRect()

  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  )
}

function ResizeHandle({ store, width }: { store: BrowserPanelStore; width: number }) {
  const drag = useRef<{
    readonly pointerId: number
    readonly element: HTMLHRElement
    readonly startX: number
    readonly startWidth: number
    /* 最后已知的指针位置：收尾时用它判定指针是否还在条上。 */
    point: { readonly x: number; readonly y: number }
  } | null>(null)

  const settle = (session: NonNullable<typeof drag.current>): void => {
    drag.current = null

    /* lostpointercapture 时捕获已释放，此时 release 会抛 NotFoundError。 */
    if (session.element.hasPointerCapture(session.pointerId)) {
      session.element.releasePointerCapture(session.pointerId)
    }

    store.setSplitterActivity(isPointerOver(session.element, session.point) ? 'hover' : 'idle')
  }

  const handlePointerEnd = (event: PointerEvent<HTMLHRElement>): void => {
    const session = drag.current

    if (session?.pointerId !== event.pointerId) {
      return
    }

    settle(session)
  }

  /* 悬停只在没有会话时由指针进出改写；拖拽中的进出由 settle 统一收尾。 */
  const handlePointerEnter = (): void => {
    if (drag.current === null) {
      store.setSplitterActivity('hover')
    }
  }

  const handlePointerLeave = (): void => {
    if (drag.current === null) {
      store.setSplitterActivity('idle')
    }
  }

  /* 条随面板收起而卸载：谁写的状态谁收回，否则再展开时拖拽态还挂着。 */
  useEffect(
    () => () => {
      store.setSplitterActivity('idle')
    },
    [store],
  )

  return (
    /* 拖拽宽度。交互态写进 store，离开 drag 的那一次收尾落盘，与侧栏同款。 */
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
      onLostPointerCapture={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current !== null) {
          return
        }

        event.preventDefault()
        event.stopPropagation()

        const element = event.currentTarget

        drag.current = {
          pointerId: event.pointerId,
          element,
          startX: event.clientX,
          startWidth: width,
          point: { x: event.clientX, y: event.clientY },
        }

        store.setSplitterActivity('drag')
        element.setPointerCapture(event.pointerId)
      }}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerMove={(event) => {
        const current = drag.current

        if (current === null || current.pointerId !== event.pointerId) {
          return
        }

        current.point = { x: event.clientX, y: event.clientY }

        store.setPanelWidth(current.startWidth + (current.startX - event.clientX))
      }}
      onPointerUp={handlePointerEnd}
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
      {/* 装载中的不定式进度：内核只报 Started/Finished，画不出百分比，不假装。 */}
      {activeTab?.loading === true ? (
        <div
          aria-hidden
          className="absolute inset-x-0 -bottom-px h-0.5 animate-pulse bg-current/40"
        />
      ) : null}
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

      {/* 图二：拾取一个网页元素，结果落进对话草稿。空白页没得拾。 */}
      <ToolbarButton
        disabled={!canDrive}
        label="选择网页元素加入聊天"
        onClick={() => {
          if (activeTab !== null) {
            actions.pickElement(activeTab.id)
          }
        }}
      >
        <Crosshair aria-hidden className="size-4" />
      </ToolbarButton>

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
