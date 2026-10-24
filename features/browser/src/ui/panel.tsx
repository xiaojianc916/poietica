import { ArrowLeft, ArrowRight, Globe, RotateCw, Square, SquareDashedMousePointer } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BrowserTab } from '../contract'
import type { BrowserApi } from './api'
import { BrowserOverflowMenu, ZOOM_MAX, ZOOM_MIN } from './overflow-menu'
import type { BrowserPanelStore } from './store'
import { alignViewport, type ViewportAlignment } from './viewport'

/* 浏览器面板本体：类名、DOM 形状、间距、动画、空态文案照 legacy 一字未改，只换数据来源 —— 面板读宿主标签面
 * （store），不直接认识 RPC。页面本体是主窗口的原生子 webview，按逻辑坐标摆在下方视口区域上，这个组件只画「面板的壳」。
 * agent 正在驾驶这张浏览器时，网页内容四周那圈流光由 browser-panel.css 按视口占位上的 data-browser-agent-ring 画。 */

/** 页面给环形描边让出的边宽：原生子视图盖在 DOM 之上，四周不让出一条边这圈线就看不见（与 CSS 的 --browser-agent-ring-width 同值）。 */
export const AGENT_RING_WIDTH = 3

export interface BrowserPanelProps {
  readonly api: BrowserApi
  readonly store: BrowserPanelStore
  /** 变了就重新起跑视口对齐；内容不解读，只做同一性比较。 */
  readonly layoutSignal: unknown
  readonly visible: boolean
  readonly report: (message: string, cause?: unknown) => void
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
  /*
   * 菜单是浮层（DropdownMenuContent 挂在 body 上），不占布局 —— 以前这里还按菜单高度在工具栏下面
   * 垫一块等高占位让它「让位」，那块占位带底色和下缘线，在深色面板上就是一条凭空发亮的横线
   * （用户 2026-10-19 报告）。浮层不需要让位，占位连同 menuHeight 一起删除。
   */
  const [menuOpen, setMenuOpen] = useState(false)

  /* 该露面还是该收起只能下发给宿主；卸载时补一发 false，否则面板被拆掉后视图会留在屏幕上。 */
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
      <div className="shrink-0">
        <BrowserToolbar
          activeTab={activeTab}
          api={api}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          onPickToggle={onPickToggle}
          report={report}
          state={state}
        />
      </div>
      <Viewport
        api={api}
        driven={state?.driven === true}
        layoutSignal={layoutSignal}
        report={report}
        showEmpty={activeTab === null || activeTab.url === null}
        visible={visible}
      />
    </div>
  )
}

interface BrowserToolbarProps {
  readonly activeTab: BrowserTab | null
  readonly api: BrowserApi
  readonly menuOpen: boolean
  readonly onMenuOpenChange: (open: boolean) => void
  readonly onPickToggle: (tabId: number, picking: boolean) => void
  readonly report: (message: string, cause?: unknown) => void
  readonly state: ReturnType<BrowserPanelStore['snapshot']>
}

function BrowserToolbar({
  activeTab,
  api,
  menuOpen,
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
          <ArrowLeft aria-hidden />
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
          <ArrowRight aria-hidden />
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
          {loading ? <Square aria-hidden /> : <RotateCw aria-hidden />}
        </ToolbarButton>

        <AddressInput activeTab={activeTab} api={api} report={report} />

        <ToolbarButton
          className="enabled:hover:text-primary aria-pressed:text-primary"
          disabled={!canDrive}
          label={picking ? '关闭元素选择' : '选择网页元素'}
          onClick={() => {
            if (activeTab !== null) {
              onPickToggle(activeTab.id, !picking)
            }
          }}
          pressed={picking}
        >
          <SquareDashedMousePointer aria-hidden />
        </ToolbarButton>

        <BrowserOverflowMenu
          commands={{}}
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
          zoomLevel={activeTab?.zoom ?? 0}
        />
      </div>
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

  useEffect(() => {
    if (!editing.current) {
      setDraft(committed)
    }
  }, [committed])

  return (
    <input
      aria-label="地址栏"
      className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2.5 text-xs outline-none placeholder:opacity-50 "
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
  className,
  disabled,
  label,
  onClick,
  pressed,
}: {
  readonly children: ReactNode
  readonly className?: string
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
  readonly pressed?: boolean
}): ReactNode {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={`${className ?? ''} flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 enabled:hover:bg-launcher enabled:hover:opacity-100 aria-pressed:bg-current/10 aria-pressed:opacity-100 disabled:opacity-30`}
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
  driven,
  layoutSignal,
  report,
  showEmpty,
  visible,
}: {
  readonly api: BrowserApi
  /** agent 正在驾驶：页面四周各让出一条边，环形描边才露得出来。 */
  readonly driven: boolean
  readonly layoutSignal: unknown
  readonly report: (message: string, cause?: unknown) => void
  readonly showEmpty: boolean
  readonly visible: boolean
}): ReactNode {
  const region = useRef<HTMLDivElement | null>(null)
  const alignment = useRef<ViewportAlignment | null>(null)
  /* 收起、被浮层盖住时不画这圈线：那时原生视图本来就不露面。 */
  const ring = driven && visible

  useEffect(() => {
    const element = region.current

    if (element === null) {
      return undefined
    }

    const running = alignViewport(element, (bounds) => {
      /* 四周各让出一条边：环形那圈线画在视口占位上，页面盖上去就没了。不画线时页面铺满视口，与基准一致。 */
      const edge = ring ? AGENT_RING_WIDTH : 0

      void api
        .setBounds({
          x: bounds.x + edge,
          y: bounds.y + edge,
          width: Math.max(1, bounds.width - edge * 2),
          height: Math.max(1, bounds.height - edge * 2),
        })
        .catch((cause: unknown) => {
          report('浏览器视口没能对齐', cause)
        })
    })

    alignment.current = running

    return () => {
      alignment.current = null
      running.stop()
    }
  }, [api, ring, report])

  useEffect(() => {
    alignment.current?.follow(layoutSignal)
  }, [layoutSignal])

  /* 底部让出一条圆角半径：页面本体是原生子 webview，整幅盖在宿主 DOM 之上，面板那层的圆角与 overflow 裁不到它 —— 不缩这一条，页面会把面板底部的两个圆角盖成直角。 */
  return (
    <div
      className="relative mb-[var(--workspace-card-radius)] min-h-0 flex-1"
      data-browser-agent-ring={ring ? 'true' : undefined}
      data-browser-viewport=""
      data-visible={visible ? 'true' : 'false'}
      ref={region}
    >
      {showEmpty ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Globe aria-hidden className=" opacity-30" />
          <p className="text-sm font-medium">浏览器</p>
          <p className="text-xs opacity-50">粘贴或输入 URL 以打开网页。</p>
        </div>
      ) : null}
    </div>
  )
}
