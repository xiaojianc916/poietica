import { ArrowLeft, ArrowRight, Globe, RotateCw, Square, SquareDashedMousePointer } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BrowserTab } from '../contract'
import type { BrowserApi } from './api'
import { BrowserOverflowMenu, ZOOM_MAX, ZOOM_MIN } from './overflow-menu'
import type { BrowserPanelStore } from './store'
import { alignViewport, type ViewportAlignment } from './viewport'

/* 浏览器面板本体：类名、DOM 形状、间距、动画、空态文案照 legacy 一字未改，只换数据来源 —— 面板读宿主标签面
 * （store），不直接认识 RPC。页面本体是主窗口的原生子 webview，按逻辑坐标摆在下方视口区域上，这个组件只画「面板的壳」。 */

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
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuHeight, setMenuHeight] = useState(0)

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

/** driven 为真时面板顶部多一条信息带。 */
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
          <SquareDashedMousePointer aria-hidden className="size-4" />
        </ToolbarButton>

        <BrowserOverflowMenu
          commands={{}}
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

  useEffect(() => {
    alignment.current?.follow(layoutSignal)
  }, [layoutSignal])

  /* 底部让出一条圆角半径：页面本体是原生子 webview，整幅盖在宿主 DOM 之上，面板那层的圆角与 overflow 裁不到它 —— 不缩这一条，页面会把面板底部的两个圆角盖成直角。 */
  return (
    <div
      className="relative mb-[var(--workspace-card-radius)] min-h-0 flex-1"
      data-browser-viewport=""
      data-visible={visible ? 'true' : 'false'}
      ref={region}
    >
      {showEmpty ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Globe aria-hidden className="size-8 opacity-30" />
          <p className="text-sm font-medium">浏览器</p>
          <p className="text-xs opacity-50">粘贴或输入 URL 以打开网页。</p>
        </div>
      ) : null}
    </div>
  )
}
