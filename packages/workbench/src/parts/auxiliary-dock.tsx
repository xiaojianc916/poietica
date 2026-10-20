import {
  builtinPoints,
  type Contributed,
  type DockPaneSet,
  FeatureScope,
  isSettingsDockOwner,
  type PanelItem,
  panelAdmits,
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
 * 右侧面板坞。两类贡献：无 dockTabs 的是「pane」（活在 LayoutService 的 panes 分账里，一开一个标签）；
 * 有 dockTabs 的是「组」（页签由功能自己的 store 给，坞只聚合展示）。
 * 贡献按 scope 分两类：对话等普通表面的坞画标签条 / 启动器；设置页的坞只画那一页自己的格（见 SettingsDock）。
 */

type PanelContribution = Contributed<PanelItem>
type DockTabs = NonNullable<PanelItem['dockTabs']>
type DockTab = ReturnType<DockTabs['tabs']>[number]

interface GroupView {
  readonly contribution: PanelContribution
  readonly tabs: readonly DockTab[]
}

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
/* 组页签带组前缀：两个组可能有 id 相同的标签，前缀挡住 DOM id 撞车。 */
const auxiliaryGroupTabId = (groupId: string, tabId: string) => `auxiliary-browser-${groupId}-${tabId}`

/* 方向键在 [role=tab] 之间成环走，Home/End 到两端；Delete 关闭当前页签并把焦点交给下一个/上一个/加号按钮。 */
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

/* 图标↔叉的取色规则在 features/browser 的 browser-panel.css，这里不写第二遍。 */
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
        'flex min-w-24 max-w-44 shrink-0 items-center rounded-sm text-xs leading-none ' +
        (active
          ? 'gap-0.5 border border-[#4c4c4c] bg-[#2a2a2a] py-1 pl-1.5 pr-1.5'
          : 'gap-1.5 py-[5px] pl-2 pr-2 hover:bg-[#2a2a2a]')
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
      <span aria-hidden className="auxiliary-tab-icon relative size-4 shrink-0 self-center">
        <span className="auxiliary-tab-icon__glyph pointer-events-none absolute inset-0 transition-opacity">
          {icon}
        </span>
        <X
          className="auxiliary-tab-icon__close pointer-events-none absolute inset-0 size-4 opacity-0 transition-opacity"
          data-close-tab
        />
      </span>
      <span className="min-w-0 self-center truncate">{title}</span>
    </button>
  )
}

/* groups 必须由调用方 useMemo 保持引用稳定：否则坞每帧重画都会重订一遍，订阅集合跟着抖动。 */
function useGroupTabs(groups: readonly PanelContribution[]): readonly GroupView[] {
  const [views, setViews] = useState<readonly GroupView[]>(() => readGroupTabs(groups))

  useEffect(() => {
    setViews(readGroupTabs(groups))

    const stops = groups.flatMap((group) => {
      const dockTabs = group.item.dockTabs
      if (dockTabs === undefined) {
        return []
      }

      return [
        dockTabs.subscribe(() => {
          /* 组数是个位数，整批重读不比按组挑更贵。 */
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

function readGroupTabs(groups: readonly PanelContribution[]): readonly GroupView[] {
  return groups.flatMap((group) => {
    const dockTabs = group.item.dockTabs
    return dockTabs === undefined ? [] : [{ contribution: group, tabs: dockTabs.tabs() }]
  })
}

const scopeOf = (contribution: PanelContribution) => contribution.item.scope ?? 'surface'

export function AuxiliaryDock(): ReactNode {
  const kernel = useKernel()
  const layoutState = useLayout()
  const panesState = useObservable(kernel.kernelServices.layout.panes)
  const contributions = useContributions(builtinPoints.panels)

  /* 坞里画谁的内容看 auxiliary.owner（收起过渡期间保持上一位）；设置页每一页一位，只有那一页自己的格，形状也不同。 */
  const owner = layoutState.auxiliary.owner
  const paneSet = owner === null ? null : (panesState.byOwner[owner] ?? null)
  const settings = owner !== null && isSettingsDockOwner(owner)
  /* ContributionRegistry.list 已按 order 升序返回，这里只筛、不排序。没有归属时按普通表面筛（启动器的候选）。 */
  const rightPanels = useMemo(
    () =>
      contributions.filter(
        (c) =>
          c.item.location === 'right' && (owner === null ? scopeOf(c) === 'surface' : panelAdmits(scopeOf(c), owner)),
      ),
    [contributions, owner],
  )

  return (
    <aside aria-label="辅助面板" className="flex h-full min-h-0 flex-col" id="workspace-auxiliary-panel">
      {settings ? (
        <SettingsDock paneSet={paneSet} panels={rightPanels} />
      ) : (
        <SurfaceDock paneSet={paneSet} panels={rightPanels} />
      )}
    </aside>
  )
}

/**
 * 设置页的坞：只画选中的那一格本身。设置页的格是随设置项现开的（技能文档），只有这一种内容，
 * 标签条、启动器、加号菜单与全屏都没有意义 —— 收起靠再点一次同一行或拖分隔条。
 */
function SettingsDock({
  paneSet,
  panels,
}: {
  readonly paneSet: DockPaneSet | null
  readonly panels: readonly PanelContribution[]
}): ReactNode {
  const open = paneSet === null ? [] : panels.filter((c) => paneSet.ids.includes(c.item.id))
  const body = open.find((c) => c.item.id === paneSet?.activeId) ?? open.at(-1) ?? null
  return body === null ? null : <PanelBody contribution={body} />
}

function PanelBody({ contribution }: { readonly contribution: PanelContribution }): ReactNode {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <FeatureScope featureId={contribution.featureId} key={contribution.item.id}>
        <Suspense fallback={<PartSkeleton />}>
          <contribution.item.component />
        </Suspense>
      </FeatureScope>
    </div>
  )
}

function SurfaceDock({
  paneSet,
  panels,
}: {
  readonly paneSet: DockPaneSet | null
  readonly panels: readonly PanelContribution[]
}): ReactNode {
  const kernel = useKernel()
  const layoutService = kernel.kernelServices.layout
  const layoutState = useLayout()
  const paneContributions = useMemo(() => panels.filter((c) => c.item.dockTabs === undefined), [panels])
  const groups = useMemo(() => panels.filter((c) => c.item.dockTabs !== undefined), [panels])
  const groupTabs = useGroupTabs(groups)

  /* 坞只在前台的坞开着时可交互（不在场时整列 inert），所以动作一律落在前台那一位身上。 */
  const front = layoutState.auxiliary.activeOwner

  /* 只认确实有 pane 贡献的 id：组 id 不进 pane 标签，未知 id 也不许把无关贡献画出来。 */
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

  const offers = useMemo<readonly AuxiliaryOffer[]>(
    () =>
      panels
        .filter((c) => c.item.offer !== false)
        .map((c) => ({
          kind: c.item.id,
          label: c.item.title,
          description: c.item.description ?? '',
          icon: <c.item.icon aria-hidden className="size-3.5 shrink-0 opacity-60" />,
        })),
    [panels],
  )

  /* pane 开进前台那一份；组先让它自己开，再把前台的选中格指到组贡献 id。 */
  const openOffer = (kind: string): void => {
    const contribution = panels.find((c) => c.item.id === kind)

    if (contribution === undefined || front === null) {
      return
    }

    const dockTabs = contribution.item.dockTabs

    if (dockTabs !== undefined) {
      dockTabs.onOpen()
      layoutService.focusPane(front, kind)
      layoutService.setDockOpen(front, true)
      return
    }

    layoutService.openPane(front, kind)
  }

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
          if (front !== null) {
            layoutService.focusPane(front, paneId)
          }
        },
        onClose: () => {
          if (front !== null) {
            layoutService.closePane(front, paneId)
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
          active: paneSet?.activeId === groupId && tab.active,
          onSelect: () => {
            dockTabs.onSelect(tab.id)
            if (front !== null) {
              layoutService.focusPane(front, groupId)
            }
          },
          onClose: () => {
            dockTabs.onClose(tab.id)
          },
        })
      }
    }

    return views
  }, [front, groupTabs, layoutService, openPaneContributions, paneSet])

  const showLauncher = openPaneContributions.length === 0 && groupTabs.every((g) => g.tabs.length === 0)

  /* 兜底次序：active pane → active 组 → 最后一个已开 pane → 有页签的组（页签还在时启动器不许盖住它）。 */
  const activePane =
    paneSet === null ? null : (openPaneContributions.find((c) => c.item.id === paneSet.activeId) ?? null)
  const activeGroup =
    activePane === null ? (groupTabs.find((group) => group.contribution.item.id === paneSet?.activeId) ?? null) : null
  const fallbackPane = openPaneContributions.at(-1) ?? null
  const fallbackGroup = groupTabs.find((group) => group.tabs.length > 0) ?? null
  const body = activePane ?? activeGroup?.contribution ?? fallbackPane ?? fallbackGroup?.contribution ?? null

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuHeight, setMenuHeight] = useState(0)

  if (showLauncher) {
    return <AuxiliaryLauncher offers={offers} onOpen={openOffer} />
  }

  return (
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
        /* 理论上到不了，留一条兜底只为不画白板。 */
        <AuxiliaryLauncher offers={offers} onOpen={openOffer} />
      ) : (
        <PanelBody contribution={body} />
      )}
    </>
  )
}

/*
 * 左让位 = 圆角半径 − 4px（面板左上缺口是半径 16px 的圆，标签左缘落在 12px 时才顺着弧走）；
 * 右让位 = 圆角半径 + 开关控件宽 + 行内间距，全屏时外壳把开关收走，这一份随之收回。
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
        /* 只负责让位，不许画边：画了就是标签条下面凭空多一条线。 */
        <div aria-hidden className="bg-muted/30" style={{ blockSize: menuHeight }} />
      ) : null}
    </div>
  )
}

/* 深色下 hover 的规则见 auxiliary.css。 */
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
