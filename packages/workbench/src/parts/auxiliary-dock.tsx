import {
  builtinPoints,
  type Contributed,
  FeatureScope,
  type PanelItem,
  useContributions,
  useKernel,
  useLayout,
  useObservable,
} from '@poietica/ui-kernel'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react'
import { AuxiliaryNewTabMenu, type AuxiliaryOffer } from './auxiliary-menu'
import { PartSkeleton } from './part-skeleton'

/*
 * 右侧面板坞。**迁移自** legacy：
 *   - `packages/workspace/src/panels/auxiliary-panel.tsx`（外壳结构、启动器空态）
 *   - `packages/workspace/src/panels/auxiliary-tab-strip.tsx`（标签条、键盘移动、关闭接力）
 *   - `packages/workspace/src/panels/auxiliary-menu.tsx`（加号菜单，见同目录 auxiliary-menu.tsx）
 *
 * 只换数据来源：legacy 的 AuxiliaryPanelStore 按 owner 存 panes，这里换成 ui-kernel 的
 * LayoutService（`panes` 按 owner 分账、`auxiliary.owner/activeOwner/fullscreen`）；
 * 各类面板本体由功能经 `panels` 贡献点注入 —— legacy 的 AuxiliaryPaneRenderers/宿主的
 * paneOffers 两张表在这里合成一条贡献点（03 页 §4）。
 *
 * 两类贡献：
 *   - 无 dockTabs 的是「pane」：活在 LayoutService 的 panes 分账里，一开一个标签；
 *   - 有 dockTabs 的是「组」（浏览器）：页签由功能自己的 store 给，坞只聚合展示。
 *
 * 视觉以 legacy 为绝对权威：DOM 层级、类名、行高、让位算式与键盘行为逐字照旧。
 */

type PanelContribution = Contributed<PanelItem>
type DockTabs = NonNullable<PanelItem['dockTabs']>
type DockTab = ReturnType<DockTabs['tabs']>[number]

/** 一个组（有 dockTabs 的贡献）此刻的全部页签。 */
interface GroupView {
  readonly contribution: PanelContribution
  readonly tabs: readonly DockTab[]
}

/** 标签条里一格已经摊平了的页签：点击/关闭该做什么都已经绑好。 */
interface TabView {
  readonly key: string
  readonly domId: string
  readonly title: string
  readonly icon: ReactNode
  readonly active: boolean
  readonly onSelect: () => void
  readonly onClose: () => void
}

export const AUXILIARY_TABPANEL_ID = 'auxiliary-tabpanel'

const auxiliaryPaneTabId = (id: string) => `auxiliary-pane-${id}`
/* 组页签带上组 id：两个组可能各有 id 相同的标签（legacy 只有浏览器一个组，DOM id 在此前
 * 是 `auxiliary-browser-<tabId>`；多一个组前缀只是把潜在的 id 撞车挡住，视觉不变）。 */
const auxiliaryGroupTabId = (groupId: string, tabId: string) => `auxiliary-browser-${groupId}-${tabId}`

/*
 * 键盘移动与关闭接力：**逐字迁移** legacy auxiliary-tab-strip.tsx。
 * 方向键在 `[role=tab]` 之间成环走，Home/End 到两端；Delete 关闭当前页签并把焦点交给
 * 下一个/上一个/加号按钮（`[data-auxiliary-tab-fallback]` 标记的那一处）。
 */
function moveTabFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return
  }

  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0 || tabs.length === 0) {
    return
  }

  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next]?.focus()
  tabs[next]?.click()
}

function closeFocusedTab(tab: HTMLButtonElement, onClose: () => void): void {
  const list = tab.closest('[role="tablist"]')
  const tabs = list === null ? [] : [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const index = tabs.indexOf(tab)
  const fallback = list?.parentElement?.querySelector<HTMLButtonElement>('[data-auxiliary-tab-fallback] button')
  const next = tabs[index + 1] ?? tabs[index - 1] ?? fallback

  next?.focus()
  if (next?.getAttribute('role') === 'tab') {
    next.click()
  }
  onClose()
}

/*
 * 一格标签。**逐字迁移** legacy AuxiliaryTab：大小、圆角、内边距、图标↔叉的类名与
 * data 属性、Delete 与指针行为都照旧。图标↔叉的取色规则在 features/browser 的
 * browser-panel.css（同一份 legacy 声明迁过去的那一处，这里不写第二遍）。
 */
function AuxiliaryTab({
  active,
  icon,
  id,
  onClose,
  onSelect,
  title,
}: {
  readonly active: boolean
  readonly icon: ReactNode
  readonly id: string
  readonly onClose: () => void
  readonly onSelect: () => void
  readonly title: string
}) {
  return (
    <button
      aria-controls={AUXILIARY_TABPANEL_ID}
      aria-keyshortcuts="Delete"
      aria-selected={active}
      className={
        'flex min-w-24 max-w-44 shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-2 ' +
        (active ? 'bg-tab-active' : 'hover:bg-tab-hover')
      }
      id={id}
      onClick={(event) => {
        if ((event.target as Element).closest('[data-close-tab]') !== null) {
          onClose()
          return
        }
        onSelect()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Delete') {
          event.preventDefault()
          event.stopPropagation()
          closeFocusedTab(event.currentTarget, onClose)
        }
      }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('[data-close-tab]') !== null) {
          event.preventDefault()
        }
      }}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      <span aria-hidden className="auxiliary-tab-icon relative size-3.5 shrink-0">
        <span className="auxiliary-tab-icon__glyph pointer-events-none absolute inset-0 transition-opacity">
          {icon}
        </span>
        <X
          className="auxiliary-tab-icon__close pointer-events-none absolute inset-0 size-3.5 opacity-0 transition-opacity"
          data-close-tab
        />
      </span>
      <span className="min-w-0 truncate text-xs">{title}</span>
    </button>
  )
}

/*
 * 组页签的聚合订阅：一个 hook 订所有组的 subscribe，变化时重读 tabs()。
 *
 * groups 由调用方 useMemo 保持引用稳定：没有这一条，坞每帧重画都会重订一遍，
 * 订阅集合跟着抖动。快照由**订阅回调自己**算（不是在渲染期算完再拿 epoch 当信号）——
 * 依赖数组里因此只有 groups 一个真依赖，不需要「多余依赖」那种 lint 例外。
 */
function useGroupTabs(groups: readonly PanelContribution[]): readonly GroupView[] {
  const [views, setViews] = useState<readonly GroupView[]>(() => readGroupTabs(groups))

  useEffect(() => {
    /* 组换了一批：立刻按新的这一批重算一次，再重订。 */
    setViews(readGroupTabs(groups))

    const stops = groups.flatMap((group) => {
      const dockTabs = group.item.dockTabs
      if (dockTabs === undefined) {
        return []
      }

      return [
        dockTabs.subscribe(() => {
          /* 这一组自己通报了：整批重读一遍（组数是个位数，重读不比按组挑更贵）。 */
          setViews(readGroupTabs(groups))
        }),
      ]
    })

    return () => {
      for (const stop of stops) {
        stop()
      }
    }
  }, [groups])

  return views
}

/** 把「哪些组有页签、各自有哪些页签」一次读全。 */
function readGroupTabs(groups: readonly PanelContribution[]): readonly GroupView[] {
  return groups.flatMap((group) => {
    const dockTabs = group.item.dockTabs
    return dockTabs === undefined ? [] : [{ contribution: group, tabs: dockTabs.tabs() }]
  })
}

export function AuxiliaryDock(): ReactNode {
  const kernel = useKernel()
  const layoutService = kernel.kernelServices.layout
  const layoutState = useLayout()
  const panesState = useObservable(layoutService.panes)
  const contributions = useContributions(builtinPoints.panels)

  /*
   * 取 right 的贡献并按 order 排序：ContributionRegistry.list 已经按 order 升序返回，
   * 这里只分组，不改变次序。无 dockTabs 的是 pane，有 dockTabs 的是组。
   */
  const rightPanels = useMemo(() => contributions.filter((c) => c.item.location === 'right'), [contributions])
  const paneContributions = useMemo(() => rightPanels.filter((c) => c.item.dockTabs === undefined), [rightPanels])
  const groups = useMemo(() => rightPanels.filter((c) => c.item.dockTabs !== undefined), [rightPanels])
  const groupTabs = useGroupTabs(groups)

  const owner = layoutState.auxiliary.owner
  const activeOwner = layoutState.auxiliary.activeOwner
  const right = layoutState.right
  /* 归属缺席时没有可投影的一格；pane 分账也只认字符串 owner 这一档。 */
  const paneSet = owner === null ? null : (panesState.byOwner[owner] ?? null)

  /*
   * 已开 pane 的贡献：只认集合里**确实有 pane 贡献**的 id。组 id 不进 pane 标签，
   * 未知 id 也不许把无关贡献画出来。
   */
  const openPaneContributions = useMemo(() => {
    if (paneSet === null) {
      return []
    }

    const byId = new Map(paneContributions.map((c) => [c.item.id, c]))
    return paneSet.ids.flatMap((id) => {
      const contribution = byId.get(id)
      return contribution === undefined ? [] : [contribution]
    })
  }, [paneContributions, paneSet])

  /* 启动器/加号菜单共用一份 opens：offer !== false 的 pane 贡献 + 全部 dockTabs 组。 */
  const offers = useMemo<readonly AuxiliaryOffer[]>(
    () =>
      rightPanels
        .filter((c) => c.item.offer !== false)
        .map((c) => ({
          kind: c.item.id,
          label: c.item.title,
          description: c.item.description ?? '',
          icon: <c.item.icon aria-hidden className="size-3.5 shrink-0 opacity-60" />,
        })),
    [rightPanels],
  )

  /*
   * 点开一条 offer。pane 开进当前归属（owner 缺席时先落到 activeOwner，与 legacy
   * 「开关打开的是当前对话的右栏」同义）；组先让它自己开（onOpen），再把坞的 active
   * 指到组贡献 id，归属缺席同样先补 activeOwner。
   */
  const openOffer = (kind: string): void => {
    const contribution = rightPanels.find((c) => c.item.id === kind)

    if (contribution === undefined) {
      return
    }

    const dockTabs = contribution.item.dockTabs

    if (dockTabs !== undefined) {
      dockTabs.onOpen()
      if (owner === null) {
        layoutService.setAuxiliaryOwner(activeOwner)
      }
      layoutService.setPanelActive('right', kind)
      return
    }

    /* 归属两栏都空 = 当下没有前台，面板无处可落（legacy 的 openPane 在 owner 为 null 时
     * 直接返回）。 */
    const target = owner ?? activeOwner
    if (target !== null) {
      layoutService.openPane(target, kind)
    }
  }

  /* 摊平标签条：pane 标签 + 每个组的页签，同一行、同一套 AuxiliaryTab。 */
  const tabs = useMemo<TabView[]>(() => {
    const views: TabView[] = []

    for (const contribution of openPaneContributions) {
      const paneId = contribution.item.id
      views.push({
        key: `pane:${paneId}`,
        domId: auxiliaryPaneTabId(paneId),
        title: contribution.item.title,
        icon: <contribution.item.icon aria-hidden className="size-3.5 shrink-0 opacity-60" />,
        active: paneSet?.activeId === paneId,
        onSelect: () => {
          const target = owner ?? activeOwner
          if (target !== null) {
            layoutService.focusPane(target, paneId)
          }
        },
        onClose: () => {
          if (owner !== null) {
            layoutService.closePane(owner, paneId)
          }
        },
      })
    }

    for (const group of groupTabs) {
      const dockTabs = group.contribution.item.dockTabs
      if (dockTabs === undefined) {
        continue
      }

      const groupId = group.contribution.item.id
      for (const tab of group.tabs) {
        views.push({
          key: `group:${groupId}:${tab.id}`,
          domId: auxiliaryGroupTabId(groupId, tab.id),
          title: tab.title,
          icon: tab.icon,
          active: right.activeId === groupId && tab.active,
          onSelect: () => {
            dockTabs.onSelect(tab.id)
            if (owner === null) {
              layoutService.setAuxiliaryOwner(activeOwner)
            }
            layoutService.setPanelActive('right', groupId)
          },
          onClose: () => {
            dockTabs.onClose(tab.id)
          },
        })
      }
    }

    return views
  }, [activeOwner, groupTabs, layoutService, openPaneContributions, owner, paneSet, right.activeId])

  /* 空态是「一个 pane 都没开、所有组也一个页签都没有」，不是回退态。 */
  const showLauncher = openPaneContributions.length === 0 && groupTabs.every((g) => g.tabs.length === 0)

  /*
   * 正文解析：优先当前归属集合的 active pane；否则坞的 active 若是某个组 id 就渲染该组；
   * 否则落最后一个已开 pane；再退到「有页签的组」兜底（页签还在，启动器不许盖住它）。
   */
  const activePane =
    paneSet === null ? null : (openPaneContributions.find((c) => c.item.id === paneSet.activeId) ?? null)
  const activeGroup =
    activePane === null ? (groupTabs.find((group) => group.contribution.item.id === right.activeId) ?? null) : null
  const fallbackPane = openPaneContributions.at(-1) ?? null
  const fallbackGroup = groupTabs.find((group) => group.tabs.length > 0) ?? null
  const body = activePane ?? activeGroup?.contribution ?? fallbackPane ?? fallbackGroup?.contribution ?? null

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuHeight, setMenuHeight] = useState(0)

  return (
    <aside aria-label="辅助面板" className="flex h-full min-h-0 flex-col" id="workspace-auxiliary-panel">
      {showLauncher ? (
        <AuxiliaryLauncher offers={offers} onOpen={openOffer} />
      ) : (
        <>
          <AuxiliaryTabStrip
            fullscreen={layoutState.auxiliary.fullscreen}
            menuHeight={menuHeight}
            menuOpen={menuOpen}
            offers={offers}
            onMenuHeightChange={setMenuHeight}
            onMenuOpenChange={setMenuOpen}
            onOpenOffer={openOffer}
            onToggleFullscreen={() => {
              layoutService.toggleAuxiliaryFullscreen()
            }}
            tabs={tabs}
          />
          {body === null ? (
            /* 理论上到不了：非空态至少有一格 pane 或一个组页签。留一条兜底只为不画白板。 */
            <AuxiliaryLauncher offers={offers} onOpen={openOffer} />
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              <FeatureScope featureId={body.featureId} key={body.item.id}>
                <Suspense fallback={<PartSkeleton />}>
                  <body.item.component />
                </Suspense>
              </FeatureScope>
            </div>
          )}
        </>
      )}
    </aside>
  )
}

/*
 * 标签条。**迁移自** legacy AuxiliaryTabStrip：让位算式、横向滚动、role=tablist、
 * 加号菜单的让位占位与全屏按钮全部照旧。
 *
 *   左 = 圆角半径再让 4px —— 面板左上那个缺口是半径 16px 的四分之一圆，标签左缘
 *   落在 12px 时它的左上角顺着弧走；右 = 圆角半径 + 开关那枚控件宽 + 行内间距，
 *   全屏时外壳把开关收走，这一份让位随之收回。
 */
function AuxiliaryTabStrip({
  fullscreen,
  menuHeight,
  menuOpen,
  offers,
  onMenuHeightChange,
  onMenuOpenChange,
  onOpenOffer,
  onToggleFullscreen,
  tabs,
}: {
  readonly fullscreen: boolean
  readonly menuHeight: number
  readonly menuOpen: boolean
  readonly offers: readonly AuxiliaryOffer[]
  readonly onMenuHeightChange: (height: number) => void
  readonly onMenuOpenChange: (open: boolean) => void
  readonly onOpenOffer: (kind: string) => void
  readonly onToggleFullscreen: () => void
  readonly tabs: readonly TabView[]
}) {
  return (
    <div className="shrink-0">
      <div
        className={
          'auxiliary-tab-strip__row flex h-10 shrink-0 items-center gap-1 pl-[calc(var(--workspace-card-radius)-0.25rem)] ' +
          (fullscreen
            ? 'pr-[var(--workspace-card-radius)]'
            : 'pr-[calc(var(--workspace-card-radius)+var(--workspace-card-control)+0.25rem)]')
        }
      >
        <div
          aria-label="辅助面板标签页"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          onKeyDown={moveTabFocus}
          role="tablist"
          style={{ scrollbarWidth: 'none' }}
        >
          {tabs.map((tab) => (
            <AuxiliaryTab
              active={tab.active}
              icon={tab.icon}
              id={tab.domId}
              key={tab.key}
              onClose={tab.onClose}
              onSelect={tab.onSelect}
              title={tab.title}
            />
          ))}
        </div>

        <span className="contents" data-auxiliary-tab-fallback>
          <AuxiliaryNewTabMenu
            offers={offers}
            onHeightChange={onMenuHeightChange}
            onOpenChange={onMenuOpenChange}
            onOpen={onOpenOffer}
            open={menuOpen}
          />
        </span>

        <button
          aria-expanded={fullscreen}
          aria-label={fullscreen ? '退出全屏显示' : '全屏显示'}
          className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 enabled:hover:bg-launcher enabled:hover:opacity-100 aria-expanded:bg-current/10 aria-expanded:opacity-100"
          onClick={onToggleFullscreen}
          title={fullscreen ? '退出全屏显示' : '全屏显示'}
          type="button"
        >
          {fullscreen ? <Minimize2 aria-hidden className="size-4" /> : <Maximize2 aria-hidden className="size-4" />}
        </button>
      </div>
      {menuOpen ? (
        /* 只负责让位：它自己不许画边（画了就是标签条下面凭空多一条线）。 */
        <div aria-hidden className="bg-muted/30" style={{ blockSize: menuHeight }} />
      ) : null}
    </div>
  )
}

/*
 * 启动器空态。**迁移自** legacy AuxiliaryLauncher：类名与排版一字未改（含深色下
 * hover 的规则，见 auxiliary.css）。offers 由调用方按 order 摊平两类贡献。
 */
function AuxiliaryLauncher({
  offers,
  onOpen,
}: {
  readonly offers: readonly AuxiliaryOffer[]
  readonly onOpen: (kind: string) => void
}) {
  return (
    <section aria-label="辅助面板启动器" className="flex h-full min-h-0 flex-col">
      <div className="m-auto w-full max-w-xs px-6">
        <div className="mt-6 grid gap-2">
          {offers.map((offer) => (
            <button
              className="auxiliary-launcher flex min-h-10 items-center gap-3 rounded-lg bg-launcher px-3 text-left hover:bg-current/[7%] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/30"
              key={offer.kind}
              onClick={() => {
                onOpen(offer.kind)
              }}
              type="button"
            >
              <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                {offer.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{offer.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{offer.description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
