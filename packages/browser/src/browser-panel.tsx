import { ArrowLeft, ArrowRight, Crosshair, Globe, RotateCw } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { BrowserOverflowMenu, type DockPaneOffer } from './browser-menu'
import type { BrowserPanelStore } from './browser-panel-store'
import type { BrowserTab } from './browser-port'
import { BrowserTabStrip } from './browser-tab-strip'

/*
 * 浏览器面板（图一）。
 *
 * 页面本体不在这棵 React 树里：它是主窗口的原生子 webview，按逻辑坐标摆在
 * 下方视口区域上。这个组件只画「面板的壳」—— 标签条、工具栏、空态 ——
 * 并把视口矩形对齐给宿主。
 */

/** 一格通道由谁描述：字形与名字进标签行，内容进主区。本包不解读 id。 */
export interface DockPaneRenderer {
  readonly icon: ReactNode
  readonly name: (id: string) => string
  readonly body: (id: string) => ReactNode
}

/** 每种通道一个渲染器，键就是 DockPane.kind。 */
export type DockPaneRenderers = Readonly<Record<string, DockPaneRenderer>>

function rendererOf(renderers: DockPaneRenderers, kind: string): DockPaneRenderer {
  const renderer = renderers[kind]

  if (renderer === undefined) {
    throw new Error(`dock 上没有 ${kind} 通道的渲染器：接线漏了。`)
  }

  return renderer
}

export interface BrowserPanelProps {
  readonly store: BrowserPanelStore
  readonly panes: DockPaneRenderers
  /** 加号菜单可开的通道种类。 */
  readonly paneOffers: readonly DockPaneOffer[]
  /** 标签条行尾的角位：宿主放面板开关，几何与宿主页头对齐。 */
  readonly trailing?: ReactNode
  /** 几何输入的指纹：变了就重新起跑视口对齐，内容不解读。 */
  readonly layoutSignal: unknown
}

export function BrowserPanel({
  layoutSignal,
  paneOffers,
  panes,
  store,
  trailing,
}: BrowserPanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const host = state.host
  const activePane = state.panes.find((pane) => pane.id === state.activePaneId) ?? null
  const activeTab = host?.tabs.find((tab) => tab.id === host.activeTabId) ?? null

  return (
    <aside aria-label="浏览器" className="flex h-full min-h-0 flex-col">
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
          <BrowserTabStrip
            actions={store.actions}
            activePaneId={state.activePaneId}
            host={host}
            onClosePane={store.closePane}
            onMenuChange={store.setMenu}
            onOpenPane={store.openPaneKind}
            onSelectPane={store.selectPane}
            openMenu={state.openMenu}
            paneOffers={paneOffers}
            panes={state.panes.map((pane) => {
              const renderer = rendererOf(panes, pane.kind)

              return { icon: renderer.icon, id: pane.id, name: renderer.name(pane.id) }
            })}
            trailing={trailing}
          />
          {activePane === null ? (
            <>
              <BrowserToolbar
                actions={store.actions}
                activeTab={activeTab}
                menuOpen={state.openMenu === 'overflow'}
                onMenuOpenChange={(next) => {
                  store.setMenu(next ? 'overflow' : null)
                }}
                pickerActive={host.pickingTabId === activeTab?.id}
              />
              <Viewport
                layoutSignal={layoutSignal}
                showEmpty={activeTab === null || activeTab.url === null}
                store={store}
              />
            </>
          ) : (
            /* 通道是只读的：没有地址栏，也没有输入框。 */
            <div className="min-h-0 flex-1 overflow-hidden">
              {rendererOf(panes, activePane.kind).body(activePane.id)}
            </div>
          )}
        </>
      )}
    </aside>
  )
}

interface BrowserToolbarProps {
  readonly activeTab: BrowserTab | null
  readonly actions: BrowserPanelStore['actions']
  readonly menuOpen: boolean
  readonly onMenuOpenChange: (open: boolean) => void
  readonly pickerActive: boolean
}

function BrowserToolbar({
  activeTab,
  actions,
  menuOpen,
  onMenuOpenChange,
  pickerActive,
}: BrowserToolbarProps) {
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

      <ToolbarButton
        disabled={!canDrive}
        label={pickerActive ? '关闭元素选择' : '选择网页元素'}
        onClick={() => {
          if (activeTab !== null) {
            actions.setElementPicker(activeTab.id, !pickerActive)
          }
        }}
        pressed={pickerActive}
      >
        <Crosshair aria-hidden className="size-4" />
      </ToolbarButton>

      <BrowserOverflowMenu
        canDrive={canDrive}
        onOpenChange={onMenuOpenChange}
        onOpenExternally={() => {
          if (activeTab?.url != null) {
            actions.openExternally(activeTab.url)
          }
        }}
        onPrint={() => {
          if (activeTab !== null) {
            actions.print(activeTab.id)
          }
        }}
        open={menuOpen}
      />
    </div>
  )
}

function AddressInput({
  activeTab,
  actions,
}: {
  readonly activeTab: BrowserTab | null
  readonly actions: BrowserPanelStore['actions']
}) {
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

function ToolbarButton({
  children,
  disabled,
  label,
  onClick,
  pressed,
}: {
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
  readonly pressed?: boolean
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 enabled:hover:bg-current/10 enabled:hover:opacity-100 aria-pressed:bg-current/10 aria-pressed:opacity-100 disabled:opacity-30"
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
  layoutSignal,
}: {
  readonly showEmpty: boolean
  readonly store: BrowserPanelStore
  readonly layoutSignal: unknown
}) {
  const region = useRef<HTMLDivElement | null>(null)
  const restart = useRef<() => void>(() => {})

  useEffect(() => {
    const element = region.current

    if (element === null) {
      return undefined
    }

    /*
     * 原生子 webview 不在 DOM 里，按窗口逻辑坐标摆放。矩形的「位置」变化不触发
     * ResizeObserver（侧栏开合、拖宽、窗口尺寸都只改位置），所以只能逐帧量；
     * 但只在几何还在动时量 —— 连续两帧不变就停机，静止时零帧回调。
     */
    let frame = 0
    let still = 0
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
        still = 0
        store.reportViewport(last)
      } else if (++still > 1) {
        frame = 0

        return
      }

      frame = requestAnimationFrame(align)
    }

    const start = () => {
      still = 0

      if (frame === 0) {
        frame = requestAnimationFrame(align)
      }
    }

    restart.current = start
    start()

    const observer = new ResizeObserver(start)

    observer.observe(element)
    window.addEventListener('resize', start)

    return () => {
      restart.current = () => {}
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', start)
    }
  }, [store])

  /* 开合与拖宽经指纹重新起跑：补间由 motion 在 React 之外推进，量不到重渲染。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 指纹不进回调是设计：删除会让面板开合后视口矩形停在旧位
  useEffect(() => {
    restart.current()
  }, [layoutSignal])

  return (
    <div className="relative min-h-0 flex-1" ref={region}>
      {showEmpty ? (
        /* 空态。活动标签是空白页时原生侧没有 webview，这里就是画面本身。 */
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Globe aria-hidden className="size-8 opacity-30" />
          <p className="text-sm font-medium">浏览器</p>
          <p className="text-xs opacity-50">粘贴或输入 URL 以打开网页。</p>
        </div>
      ) : null}
    </div>
  )
}
