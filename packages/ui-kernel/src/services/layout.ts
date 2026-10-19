import { createValue, type Observable } from './observable'

export interface PanelDockState {
  readonly open: boolean
  readonly activeId: string | null
  readonly size: number
}

/**
 * 右坞的归属状态。`owner` 是这一格归谁（由开格或坞的开关直接写），`activeOwner` 是当前前台（表面在 effect 里声明）。
 * 两者相等且 owner 非空时右坞才在场；`fullscreen` 是瞬时全屏态，不落盘。
 */
export interface AuxiliaryState {
  readonly owner: string | null
  readonly activeOwner: string | null
  readonly fullscreen: boolean
}

export interface LayoutState {
  readonly sidebar: { readonly visible: boolean; readonly width: number }
  readonly right: PanelDockState
  readonly auxiliary: AuxiliaryState
}

export interface DockPaneSet {
  readonly ids: readonly string[]
  readonly activeId: string | null
}

/**
 * 各归属的格清单。**瞬时态、不落盘**：它不进 LayoutState，所以 preferences 存盘时不会带上它，restore 也不会写回来。
 * 单独一个 Observable 是因为坞只订阅它：列宽每帧变时，标签条不必跟着整棵外壳重画。
 */
export interface DockPanesState {
  readonly byOwner: Readonly<Record<string, DockPaneSet>>
}

/** 右坞默认宽度：560。420 时 agent 驾驶内置浏览器只剩一条窄页，操作过程看不清；560 在默认 1280 窗口下仍给主列留下 440。 */
export const DEFAULT_PANEL_WIDTH = 560

/** 默认布局：侧栏 280、辅助列 560。 */
export const DEFAULT_LAYOUT: LayoutState = {
  sidebar: { visible: true, width: 280 },
  right: { open: false, activeId: null, size: DEFAULT_PANEL_WIDTH },
  auxiliary: { owner: null, activeOwner: null, fullscreen: false },
}
/**
 * 外壳三列的宽度边界，全仓只此一份：写入、读盘、渲染、分隔条与无障碍值都读这里。
 * 以前内核按布局图钳 200–480 / 280–900、外壳的分隔条另按 220–360 / 320–800 钳，两份互不认账 ——
 * 存下的宽度在分隔条上限之外时照原样画出来，第一下拖拽就被夹回去（真实故障）。
 */
export const LAYOUT_LIMITS = {
  sidebar: [220, 360],
  right: [320, 800],
  /** 主列地板：两侧列合计最多占到「外壳宽 − 地板」。 */
  mainMin: 360,
} as const

/**
 * 一侧列此刻的有效几何。`size` 是它在场时画多宽（收起过渡期间内容仍按它排，所以不在场也有值），
 * `column` 是栅格里那一列此刻的宽（不在场为 0），`min` / `max` 是它的分隔条此刻的可拖范围。
 * 在场时 `size` 恒在 `[min, max]` 里：拖拽的起点就是看到的宽度，第一下不会跳。
 */
export interface RegionGeometry {
  readonly size: number
  readonly column: number
  readonly min: number
  readonly max: number
}

export interface LayoutGeometry {
  readonly sidebar: RegionGeometry
  readonly right: RegionGeometry
}

const fit = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/**
 * 意图 + 外壳宽 → 有效几何。LayoutState 里的宽度是**意图**（用户拖出来的值），不随窗口或另一侧的开合改写；
 * 放不下时只在这里让位，放得下了原样回来。产品上限是常量，不随另一侧开合加减（以前侧栏收起会给右栏上限加回侧栏宽，
 * 「最大」本身随开合漂移，开合来回一遍就回不到原样）；另一侧只经「窗口还剩多少」影响上限，宽窗口下开合上限纹丝不动。
 *
 * 让位次序只有一条：右栏先缩（到下限为止），侧栏再缩（到下限为止），两侧都在下限仍放不下才轮到主列地板
 * （栅格的 minmax(0, 1fr) 吃掉差额）。拖拽沿用同一次序：侧栏拖到主列地板后继续推右栏，右栏拖到地板即止。
 */
export function resolveLayoutGeometry(state: LayoutState, viewportWidth: number | null): LayoutGeometry {
  const [sidebarMin, sidebarMax] = LAYOUT_LIMITS.sidebar
  const [rightMin, rightMax] = LAYOUT_LIMITS.right
  /* 两侧列合计最多能占多宽；还没量到外壳时这一维不设限。 */
  const room = viewportWidth === null ? Number.POSITIVE_INFINITY : viewportWidth - LAYOUT_LIMITS.mainMin
  const sidebarCap = fit(room - (state.right.open ? rightMin : 0), sidebarMin, sidebarMax)
  const sidebarSize = fit(state.sidebar.width, sidebarMin, sidebarCap)
  const sidebarColumn = state.sidebar.visible ? sidebarSize : 0
  const rightCap = fit(room - sidebarColumn, rightMin, rightMax)
  const rightSize = fit(state.right.size, rightMin, rightCap)
  return {
    sidebar: { size: sidebarSize, column: sidebarColumn, min: sidebarMin, max: sidebarCap },
    right: { size: rightSize, column: state.right.open ? rightSize : 0, min: rightMin, max: rightCap },
  }
}

const sameRegion = (a: RegionGeometry, b: RegionGeometry): boolean =>
  a.size === b.size && a.column === b.column && a.min === b.min && a.max === b.max

export type SplitterActivity = 'idle' | 'hover' | 'drag'
/**
 * 哪一条分隔条处于交互态。外壳只有两列一缝（侧栏 | 主区 | 辅助列），所以只有两档：
 * 侧栏右缘与辅助列左缘，没有第三条可拖的边。
 */
export type SplitterRegion = 'sidebar' | 'auxiliary'

/**
 * 分隔条此刻的交互态。它必须**可订阅**：外壳把它写成根节点上的 `data-splitter`，而 CSS 的
 * `[data-splitter="drag"] { transition: none }` 正是拖拽跟手的前提（没有它，列宽按 0.22s 插值走，指针一快主区就盖住侧栏）。
 * 写成「渲染时读瞬时变量」时值变了没有任何人重画，属性一直是 idle、悬停永远不亮（真实故障）。
 * 一次拖拽只变两三次，不进每帧路径，单独一个 Observable 足够。
 */
export interface SplitterState {
  readonly activity: SplitterActivity
  readonly region: SplitterRegion
}

export interface LayoutService extends Observable<LayoutState> {
  toggleSidebar(): void
  setSidebarWidth(px: number): void
  /**
   * 打开一个面板坞，归属是**当前前台**（`auxiliary.activeOwner`）；入口页没有前台时命令不开坞。
   */
  openPanel(location: 'right', panelId: string): void
  togglePanel(location: 'right', panelId?: string): void
  closePanel(location: 'right'): void
  setPanelSize(location: 'right', px: number): void

  readonly panes: Observable<DockPanesState>
  /** 与坞的 owner 不一致即面板离场、全屏作废。 */
  setActiveOwner(owner: string | null): void
  /** 把坞认领给某个归属；传 null 收起，收起时全屏态一并作废。 */
  setAuxiliaryOwner(owner: string | null): void
  /** 开一格（去重）并选中它，同时把坞的归属改到该 owner（不改 activeOwner）。 */
  openPane(owner: string, paneId: string): void
  closePane(owner: string, paneId: string): void
  /** 允许 dockTabs 组 id（不在 ids 里也写）。 */
  focusPane(owner: string, paneId: string): void
  setPanelActive(location: 'right', panelId: string | null): void
  /** 归属消失（对话被删等）：清掉它的格与坞 / 前台引用，并作废全屏。 */
  forgetOwner(owner: string): void
  setAuxiliaryFullscreen(fullscreen: boolean): void
  toggleAuxiliaryFullscreen(): void

  /** 拖拽中不插值、悬停 50ms 后浮现。 */
  setSplitterActivity(activity: SplitterActivity, region: SplitterRegion): void
  splitter(): SplitterActivity
  splitterRegion(): SplitterRegion
  readonly splitterState: Observable<SplitterState>
  /** 外壳此刻多宽（CSS 像素）。非有限或非正的读数（还没布局、最小化）不算数。 */
  setViewportWidth(width: number): void
  viewportWidth(): number | null
  /**
   * 有效几何（见 resolveLayoutGeometry）。画列宽、分隔条范围、无障碍值**只读这里**，不读 LayoutState 里的意图宽度。
   * 单独一个 Observable：窗口宽不是意图，不进 LayoutState，也就不落盘。
   */
  readonly geometry: Observable<LayoutGeometry>
  /** preferences 恢复上次布局；非法值按默认值与边界修正。 */
  restore(state: unknown): void
}

const clamp = (v: number, [min, max]: readonly [number, number]): number => Math.min(max, Math.max(min, Math.round(v)))

/**
 * `right.open` / `right.activeId` 是派生的，不单独记账：在场 = 坞有归属且归属正是当前前台；
 * 活动格 = 当前归属格清单里的选中格，不在场时恒为 null。派生在一处算，不变量就不会因为某条写入路径忘了同步而破。
 */
function deriveRight(state: LayoutState, panes: DockPanesState): LayoutState {
  const { owner, activeOwner } = state.auxiliary
  const open = owner !== null && owner === activeOwner
  const activeId = owner !== null && open ? (panes.byOwner[owner]?.activeId ?? null) : null
  if (state.right.open === open && state.right.activeId === activeId) return state
  return { ...state, right: { ...state.right, open, activeId } }
}

export function createLayoutService(): LayoutService {
  const v = createValue<LayoutState>(DEFAULT_LAYOUT)
  const panesValue = createValue<DockPanesState>({ byOwner: {} })

  /** 格清单与布局状态一起换：订阅者看不到「归属换了、格还没进去」的中间态。 */
  const commit = (state: LayoutState, panes: DockPanesState): void => {
    const next = deriveRight(state, panes)
    if (panes !== panesValue.current()) panesValue.set(panes)
    if (next !== v.current()) v.set(next)
  }

  const update = (fn: (s: LayoutState) => LayoutState): void => {
    commit(fn(v.current()), panesValue.current())
  }

  const updateAuxiliary = (fn: (a: AuxiliaryState) => AuxiliaryState): void => {
    const state = v.current()
    const auxiliary = fn(state.auxiliary)
    if (
      auxiliary.owner === state.auxiliary.owner &&
      auxiliary.activeOwner === state.auxiliary.activeOwner &&
      auxiliary.fullscreen === state.auxiliary.fullscreen
    ) {
      return
    }
    commit({ ...state, auxiliary }, panesValue.current())
  }

  const openPane = (owner: string, paneId: string): void => {
    const state = v.current()
    const panes = panesValue.current()
    const current = panes.byOwner[owner]
    const alreadyOpen = current?.ids.includes(paneId) === true
    const ids = alreadyOpen ? current.ids : [...(current?.ids ?? []), paneId]
    const ownerChanged = state.auxiliary.owner !== owner
    const panesChanged = current === undefined || current.activeId !== paneId || !alreadyOpen
    if (!ownerChanged && !panesChanged) return
    commit(
      ownerChanged ? { ...state, auxiliary: { ...state.auxiliary, owner } } : state,
      panesChanged ? { byOwner: { ...panes.byOwner, [owner]: { ids, activeId: paneId } } } : panes,
    )
  }

  const closePane = (owner: string, paneId: string): void => {
    const panes = panesValue.current()
    const current = panes.byOwner[owner]
    if (current === undefined || !current.ids.includes(paneId)) return
    const ids = current.ids.filter((id) => id !== paneId)
    /* 只有关掉的正是当前选中格才挪焦点（落到剩余最后一格，空则 null）；全空后坞回到启动器。 */
    const activeId = current.activeId === paneId ? (ids.at(-1) ?? null) : current.activeId
    commit(v.current(), { byOwner: { ...panes.byOwner, [owner]: { ids, activeId } } })
  }

  const focusPane = (owner: string, paneId: string): void => {
    const panes = panesValue.current()
    const current = panes.byOwner[owner]
    if (current !== undefined && current.activeId === paneId) return
    commit(v.current(), {
      byOwner: { ...panes.byOwner, [owner]: { ids: current?.ids ?? [], activeId: paneId } },
    })
  }

  const setAuxiliaryOwner = (owner: string | null): void => {
    updateAuxiliary((current) => ({
      ...current,
      owner,
      /* 收起即离场：全屏是那一格此刻的瞬时态，面板不在了就作废。 */
      fullscreen: owner === null ? false : current.fullscreen,
    }))
  }

  const setActiveOwner = (owner: string | null): void => {
    updateAuxiliary((current) => ({
      ...current,
      activeOwner: owner,
      /* 前台换人 = 这一格离场：全屏瞬时态作废，但 owner 与格清单保留。 */
      fullscreen: current.owner !== owner ? false : current.fullscreen,
    }))
  }

  const forgetOwner = (owner: string): void => {
    const state = v.current()
    const panes = panesValue.current()
    const ownsDock = state.auxiliary.owner === owner
    const ownsFront = state.auxiliary.activeOwner === owner
    if (panes.byOwner[owner] === undefined && !ownsDock && !ownsFront) return
    const byOwner = { ...panes.byOwner }
    delete byOwner[owner]
    const auxiliary: AuxiliaryState = {
      owner: ownsDock ? null : state.auxiliary.owner,
      activeOwner: ownsFront ? null : state.auxiliary.activeOwner,
      fullscreen: ownsDock || ownsFront ? false : state.auxiliary.fullscreen,
    }
    commit({ ...state, auxiliary }, { byOwner })
  }

  /* location 参数只有一个取值，留在签名里是为了调用点读起来仍是「哪一块坞」。 */
  const setPanelActive = (_location: 'right', panelId: string | null): void => {
    const owner = v.current().auxiliary.owner
    if (owner === null || panelId === null) return
    focusPane(owner, panelId)
  }

  const openPanel = (_location: 'right', panelId: string): void => {
    const owner = v.current().auxiliary.activeOwner
    if (owner === null) return
    openPane(owner, panelId)
  }

  const togglePanel = (_location: 'right', panelId?: string): void => {
    const state = v.current()
    if (state.right.open && (panelId === undefined || state.right.activeId === panelId)) {
      setAuxiliaryOwner(null)
      return
    }
    const owner = state.auxiliary.activeOwner
    if (owner === null) return
    if (panelId === undefined) {
      setAuxiliaryOwner(owner)
      return
    }
    openPanel('right', panelId)
  }

  const closePanel = (_location: 'right'): void => {
    setAuxiliaryOwner(null)
  }

  const setAuxiliaryFullscreen = (fullscreen: boolean): void => {
    updateAuxiliary((current) => ({ ...current, fullscreen }))
  }

  const toggleAuxiliaryFullscreen = (): void => {
    updateAuxiliary((current) => ({ ...current, fullscreen: !current.fullscreen }))
  }

  /* 交互态自己一个 Observable：外壳必须跟着它重画，否则 data-splitter 永远停在 idle。 */
  const splitterValue = createValue<SplitterState>({ activity: 'idle', region: 'sidebar' })
  let splitter: SplitterActivity = 'idle'
  let splitterRegion: SplitterRegion = 'sidebar'
  let viewportWidth: number | null = null
  const geometryValue = createValue<LayoutGeometry>(resolveLayoutGeometry(v.current(), viewportWidth))
  /* 意图与外壳宽任一变化都重算；算出来没变就不通知，外壳不必跟着重画。 */
  const refreshGeometry = (): void => {
    const next = resolveLayoutGeometry(v.current(), viewportWidth)
    const prev = geometryValue.current()
    if (sameRegion(next.sidebar, prev.sidebar) && sameRegion(next.right, prev.right)) return
    geometryValue.set(next)
  }
  /* 先于任何外部订阅者挂上：v 通知时几何已经是新的，订阅两者的组件读不到一新一旧。 */
  v.subscribe(refreshGeometry)

  return {
    current: v.current,
    subscribe: v.subscribe,
    panes: panesValue,
    toggleSidebar: () => update((s) => ({ ...s, sidebar: { ...s.sidebar, visible: !s.sidebar.visible } })),
    setSidebarWidth: (px) =>
      update((s) => ({ ...s, sidebar: { ...s.sidebar, width: clamp(px, LAYOUT_LIMITS.sidebar) } })),
    openPanel,
    togglePanel,
    closePanel,
    setPanelSize: (loc, px) => update((s) => ({ ...s, [loc]: { ...s[loc], size: clamp(px, LAYOUT_LIMITS[loc]) } })),
    setActiveOwner,
    setAuxiliaryOwner,
    openPane,
    closePane,
    focusPane,
    setPanelActive,
    forgetOwner,
    setAuxiliaryFullscreen,
    toggleAuxiliaryFullscreen,
    setSplitterActivity: (activity, region) => {
      // 一侧正在拖时，另一侧的悬停不夺焦点
      if (splitter === 'drag' && region !== splitterRegion) return
      if (splitter === activity && splitterRegion === region) return
      splitter = activity
      splitterRegion = region
      splitterValue.set({ activity, region })
    },
    splitter: () => splitter,
    splitterRegion: () => splitterRegion,
    splitterState: splitterValue,
    setViewportWidth: (width) => {
      /* 非有限的数会把整条上限算式变成 NaN；0 是还没布局（或窗口最小化）时的读数，按它算会把两侧压到下限。 */
      if (!Number.isFinite(width) || width <= 0) return
      const next = Math.round(width)
      if (next === viewportWidth) return
      viewportWidth = next
      refreshGeometry()
    },
    viewportWidth: () => viewportWidth,
    geometry: geometryValue,
    restore(raw) {
      const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const section = (x: unknown): Record<string, unknown> | undefined =>
        typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : undefined
      const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d)
      const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d)
      const str = (x: unknown): string | null => (typeof x === 'string' ? x : null)
      const dock = (
        x: Record<string, unknown> | undefined,
        d: PanelDockState,
        lim: readonly [number, number],
      ): PanelDockState => ({
        open: bool(x?.open, d.open),
        activeId: str(x?.activeId),
        size: clamp(num(x?.size, d.size), lim),
      })
      const sidebar = section(r.sidebar)
      /*
       * 兼容旧数据：旧形状只有 right.open / right.activeId，没有 auxiliary。归属只认 auxiliary.owner；
       * activeOwner / fullscreen 是运行期状态，读盘时恒为 null / false，restore 之后由前台表面 setActiveOwner。
       */
      const auxiliary = section(r.auxiliary)
      v.set(
        deriveRight(
          {
            sidebar: {
              visible: bool(sidebar?.visible, true),
              width: clamp(num(sidebar?.width, 280), LAYOUT_LIMITS.sidebar),
            },
            right: dock(section(r.right), DEFAULT_LAYOUT.right, LAYOUT_LIMITS.right),
            auxiliary: { owner: str(auxiliary?.owner), activeOwner: null, fullscreen: false },
          },
          panesValue.current(),
        ),
      )
    },
  }
}
