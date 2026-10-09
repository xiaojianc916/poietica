import { ArrowLeft, ArrowRight, Globe, MousePointerClick, RotateCw, Square } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BrowserTab } from '../contract'
import type { BrowserApi } from './api'
import { BrowserOverflowMenu, ZOOM_MAX, ZOOM_MIN } from './overflow-menu'
import type { BrowserPanelStore } from './store'
import { alignViewport, type ViewportAlignment } from './viewport'

/*
 * 浏览器面板本体（07 页 §12E「panels」一栏）。
 *
 * **迁移自** legacy `packages/workspace/src/panels/auxiliary-panel.tsx` 的 BrowserToolbar /
 * AddressInput / ToolbarButton / Viewport 与 `packages/browser/src/viewport-alignment.ts`
 * 的用法：类名、DOM 形状、间距、动画、空态文案一字未改。换掉的是数据来源 ——
 * 面板读的是宿主标签面（store），不直接认识 RPC。
 *
 * 页面本体不在这棵 React 树里：它是主窗口的原生子 webview，按逻辑坐标摆在下方视口
 * 区域上。这个组件只画「面板的壳」—— 工具栏、空态 —— 并把视口矩形对齐给宿主。
 *
 * 标签条不在这里：legacy 的浏览器标签与其它通道的标签同处一条（右坞的标签条），新架构
 * 里那一条由 workbench 的右边坞按 `panels` 贡献的 `dockTabs` 绘制（见 ui/index.tsx）。
 */

export interface BrowserPanelProps {
  readonly api: BrowserApi
  readonly store: BrowserPanelStore
  /** 几何输入的指纹：变了就重新起跑视口对齐；内容不解读，由 viewport.ts 只做同一性比较。 */
  readonly layoutSignal: unknown
  /** 面板此刻该不该让原生视图露面（右栏开合、活动面板、遮挡层共同决定）。 */
  readonly visible: boolean
  /** 宿主/内核层要报告的失败（面板里不做提示样式，交给 toast）。 */
  readonly report: (message: string, cause?: unknown) => void
  /** 「拾取元素」：交给 UI 装配（那里认识 attachments 与 conversation）。 */
  readonly onPickToggle: (tabId: number, picking: boolean) => void
}

export function BrowserPanel({
  api,
  store,
  layoutSignal,
  visible,
  report,
  onPickToggle,
}: BrowserPanelProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  const activeTab = state === null ? null : (state.tabs.find((tab) => tab.id === state.activeTabId) ?? null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuHeight, setMenuHeight] = useState(0)

  /*
   * 原生子 webview 不在这棵 DOM 里：面板该露面还是该收起，只能下发给宿主
   * （07 页 §12E 的「面板挂载 setVisible(true)、卸载 setVisible(false)」）。
   * 卸载时补一发 false —— 面板被拆掉后视图不能留在屏幕上。
   */
  useEffect(() => {
    void api.setVisible(visible).catch((cause: unknown) => {
      report('浏览器视图没能切换显隐', cause)
    })
  }, [api, report, visible])

  useEffect(
    () => () => {
      void api.setVisible(false).catch(() => undefined)
    },
    [api],
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-browser-panel="">
      {/* 07 页 §12E「agent 操控提示」：信息带在面板顶部，driven 为假时整条消失。 */}
      {state?.driven === true ? (
        <div className="shrink-0">
          <DrivenBanner />
        </div>
      ) : null}
      <div className="shrink-0">
        <BrowserToolbar
          activeTab={activeTab}
          api={api}
          menuHeight={menuHeight}
          menuOpen={menuOpen}
          onMenuHeightChange={setMenuHeight}
          onMenuOpenChange={setMenuOpen}
          onPickToggle={onPickToggle}
          report={report}
          state={state}
        />
      </div>
      <Viewport
        api={api}
        layoutSignal={layoutSignal}
        report={report}
        showEmpty={activeTab === null || activeTab.url === null}
        visible={visible}
      />
    </div>
  )
}

/*
 * agent 操控提示（07 页 §12E「agent 操控提示」）：driven 为真时面板顶部多一条信息带，
 * 为假时整条消失。样式沿用工具栏同一套（下缘线 + 同色底），不另立视觉语言。
 */
function DrivenBanner(): ReactNode {
  return (
    <div
      className="flex min-h-7 items-center gap-1.5 border-b border-current/10 bg-muted/30 px-2 text-xs"
      data-browser-driven=""
    >
      <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <span className="min-w-0 truncate opacity-80">AI 正在使用这个浏览器</span>
    </div>
  )
}

interface BrowserToolbarProps {
  readonly activeTab: BrowserTab | null
  readonly api: BrowserApi
  readonly menuHeight: number
  readonly menuOpen: boolean
  readonly onMenuHeightChange: (height: number) => void
  readonly onMenuOpenChange: (open: boolean) => void
  readonly onPickToggle: (tabId: number, picking: boolean) => void
  readonly report: (message: string, cause?: unknown) => void
  readonly state: ReturnType<BrowserPanelStore['snapshot']>
}

function BrowserToolbar({
  activeTab,
  api,
  menuHeight,
  menuOpen,
  onMenuHeightChange,
  onMenuOpenChange,
  onPickToggle,
  report,
  state,
}: BrowserToolbarProps): ReactNode {
  const canDrive = activeTab !== null && activeTab.url !== null
  const picking = activeTab !== null && state?.pickingTabId === activeTab.id
  const loading = activeTab?.loading === true

  const run = (task: Promise<unknown>): void => {
    void task.catch((cause: unknown) => {
      report('浏览器动作失败', cause)
    })
  }

  return (
    <div className="shrink-0">
      <div className="auxiliary-toolbar relative flex h-10 shrink-0 items-center gap-1 px-2">
        {/* 装载中的不定式进度：内核只报 Started/Finished，画不出百分比，不假装。 */}
        {loading ? (
          <div aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 animate-pulse bg-current/40" />
        ) : null}
        <ToolbarButton
          disabled={!canDrive || activeTab?.canGoBack !== true}
          label="后退"
          onClick={() => {
            if (activeTab !== null) {
              run(api.back(activeTab.id))
            }
          }}
        >
          <ArrowLeft aria-hidden className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          disabled={!canDrive || activeTab?.canGoForward !== true}
          label="前进"
          onClick={() => {
            if (activeTab !== null) {
              run(api.forward(activeTab.id))
            }
          }}
        >
          <ArrowRight aria-hidden className="size-4" />
        </ToolbarButton>
        {/*
         * 07 页 §12E 把「刷新/停止」写成同一枚按钮的两种状态：装载中下发 stop，其余刷新。
         * legacy 只有刷新 + 进度条（stop 由内核自己收尾），新架构补上停止，按钮位与尺寸不变。
         */}
        <ToolbarButton
          disabled={!canDrive}
          label={loading ? '停止' : '刷新'}
          onClick={() => {
            if (activeTab !== null) {
              run(loading ? api.stop(activeTab.id) : api.reload(activeTab.id))
            }
          }}
        >
          {loading ? <Square aria-hidden className="size-4" /> : <RotateCw aria-hidden className="size-4" />}
        </ToolbarButton>

        <AddressInput activeTab={activeTab} api={api} report={report} />

        <ToolbarButton
          disabled={!canDrive}
          label={picking ? '关闭元素选择' : '选择网页元素'}
          onClick={() => {
            if (activeTab !== null) {
              onPickToggle(activeTab.id, !picking)
            }
          }}
          pressed={picking}
        >
          <MousePointerClick aria-hidden className="size-4" />
        </ToolbarButton>

        <BrowserOverflowMenu
          onHeightChange={onMenuHeightChange}
          onOpenChange={onMenuOpenChange}
          onReopen={(index) => {
            run(api.reopenClosed(index))
          }}
          onZoom={(level) => {
            if (activeTab === null) {
              return
            }

            run(api.setZoom(activeTab.id, Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level))))
          }}
          open={menuOpen}
          recentlyClosed={state?.recentlyClosed ?? []}
          /* 缩放档的所有者是宿主（内核的 setZoomLevel）：面板不留副本，直接读标签面。 */
          zoomLevel={activeTab?.zoom ?? 0}
        />
      </div>
      {menuOpen ? (
        <div aria-hidden className="border-b border-current/10 bg-muted/30" style={{ blockSize: menuHeight }} />
      ) : null}
    </div>
  )
}

function AddressInput({
  activeTab,
  api,
  report,
}: {
  readonly activeTab: BrowserTab | null
  readonly api: BrowserApi
  readonly report: (message: string, cause?: unknown) => void
}): ReactNode {
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
      data-browser-address=""
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
        const task = activeTab === null ? api.newTab(address) : api.navigate(activeTab.id, address)

        void task.catch((cause: unknown) => {
          report('地址没能打开', cause)
        })
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
}): ReactNode {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 enabled:hover:bg-launcher enabled:hover:opacity-100 aria-pressed:bg-current/10 aria-pressed:opacity-100 disabled:opacity-30"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function Viewport({
  api,
  layoutSignal,
  report,
  showEmpty,
  visible,
}: {
  readonly api: BrowserApi
  readonly layoutSignal: unknown
  readonly report: (message: string, cause?: unknown) => void
  readonly showEmpty: boolean
  readonly visible: boolean
}): ReactNode {
  const region = useRef<HTMLDivElement | null>(null)
  const alignment = useRef<ViewportAlignment | null>(null)

  useEffect(() => {
    const element = region.current

    if (element === null) {
      return undefined
    }

    const running = alignViewport(element, (bounds) => {
      void api.setBounds(bounds).catch((cause: unknown) => {
        report('浏览器视口没能对齐', cause)
      })
    })

    alignment.current = running

    return () => {
      alignment.current = null
      running.stop()
    }
  }, [api, report])

  /* 开合与拖宽经指纹重新起跑：补间由外壳在 React 之外推进，量不到重渲染。 */
  useEffect(() => {
    alignment.current?.follow(layoutSignal)
  }, [layoutSignal])

  /*
   * 底部让出一条圆角半径。页面本体是原生子 webview（按这个元素的矩形摆放），原生层整幅
   * 盖在宿主 DOM 之上 —— 面板那层的圆角与 overflow 裁不到它，不缩这一条，页面就会把
   * 面板底部的两个圆角盖成直角。
   */
  return (
    <div
      className="relative mb-[var(--workspace-card-radius)] min-h-0 flex-1"
      data-browser-viewport=""
      data-visible={visible ? 'true' : 'false'}
      ref={region}
    >
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
