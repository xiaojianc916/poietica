import { createValue, type Observable } from './observable'

export interface PanelDockState {
  readonly open: boolean
  readonly activeId: string | null
  readonly size: number
}

/**
 * 右坞的归属状态。坞的开合、格清单与选中格都**按归属分账**（见 {@link DockPanesState}），这里只放跨归属的三格：
 * `activeOwner` 当前前台（外壳按路由写，唯一的写者）；`owner` 坞里此刻画谁的内容（派生）——
 * 前台的坞没开时保持上一位，收起 / 换前台的过渡期间内容不换人；`fullscreen` 瞬时全屏态，不落盘。
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

/** 一个归属自己的那一份坞：开没开、开着哪几格、选中哪一格。 */
export interface DockPaneSet {
  readonly ids: readonly string[]
  readonly activeId: string | null
  readonly open: boolean
}

/**
 * 各归属的那一份坞。**瞬时态、不落盘**：它不进 LayoutState，所以 preferences 存盘时不会带上它，restore 也不会写回来
 * （restore 只按存盘时在场的那一位补一条 `open`）。
 * 单独一个 Observable 是因为坞只订阅它：列宽每帧变时，标签条不必跟着整棵外壳重画。
 */
export interface DockPanesState {
  readonly byOwner: Readonly<Record<string, DockPaneSet>>
}

/**
 * 设置页的归属**按页分**：每一页一位 `settings:<页 id>`，坞的开合与格清单各记各的。
 * 以前整个设置只有一位 `'settings'`：在「技能」页开了技能文档，换到「通用」页（或退出设置再进来，落在缺省的「通用」页）
 * 坞仍然开着、画的还是技能文档。按页分账之后，一页的格只在那一页出现。
 * 设置页的坞只为设置自己的面板服务（技能文档）：不画标签条、启动器与加号菜单，也不收别的面板（见 {@link PanelScope}）。
 */
export type SettingsDockOwner = `settings:${string}`

const SETTINGS_OWNER_PREFIX = 'settings:'

/** 设置里某一页的坞归属。页 id 就是 settingsPages 贡献的 id。 */
export const settingsDockOwner = (pageId: string): SettingsDockOwner => `${SETTINGS_OWNER_PREFIX}${pageId}`

export const isSettingsDockOwner = (owner: string): owner is SettingsDockOwner =>
  owner.startsWith(SETTINGS_OWNER_PREFIX)

/**
 * 一块右坞面板服务于哪一位：`surface`（缺省）是普通表面（对话等）；`settings:<页 id>` 只属于设置里的那一页。
 * 写错了地方的开格请求（设置页里开浏览器、对话里开技能文档、「通用」页里开技能文档）在布局服务这一层就被拒，
 * 坞那一层再按同一条规则（{@link panelAdmits}）筛一遍。
 */
export type PanelScope = 'surface' | SettingsDockOwner

/** 某一位归属的坞收不收这块面板：普通面板只进普通表面；设置页的面板只进它声明的那一页。 */
export const panelAdmits = (scope: PanelScope, owner: string): boolean =>
  scope === 'surface' ? !isSettingsDockOwner(owner) : scope === owner

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
 * 意图 + 外壳宽 → 有效几何。LayoutState 里的宽度是**意图**（用户拖出来的值），不随窗口或另一侧
 * 的开合改写；放不下时只在这里让位，放得下了原样回来。产品上限是常量、不随另一侧开合加减
 * （以前侧栏收起会给右栏上限加回侧栏宽，「最大」本身随开合漂移，来回一遍回不到原样）。
 * 让位次序只有一条：右栏先缩、侧栏再缩（各到下限为止），仍放不下才轮到主列地板；拖拽同一次序。
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
   * 在**当前前台**（`auxiliary.activeOwner`）的坞里开一格并打开坞；没有前台（入口页等）时命令不开坞，
   * 面板与前台的 {@link PanelScope} 对不上时也不开。
   */
  openPanel(location: 'right', panelId: string): void
  togglePanel(location: 'right', panelId?: string): void
  /** 收起当前前台的坞（格清单保留，再打开原样还在）。 */
  closePanel(location: 'right'): void
  setPanelSize(location: 'right', px: number): void

  readonly panes: Observable<DockPanesState>
  /** 由外壳按路由写（唯一的写者）。换前台即全屏作废；新前台的坞开没开看它自己那一份。 */
  setActiveOwner(owner: string | null): void
  /**
   * 开 / 收某个归属自己的坞，不碰别的归属：在对话 A 开坞不会收掉对话 B 的。
   * 设置页没有启动器，一格都没开时打不开（打开也只是一块空白）。
   */
  setDockOpen(owner: string, open: boolean): void
  /** 开一格（去重）并选中它，同时打开该归属的坞（不改 activeOwner）。 */
  openPane(owner: string, paneId: string): void
  /** 设置页关掉最后一格即收起：那里没有启动器可以退回。 */
  closePane(owner: string, paneId: string): void
  /** 只换选中格、不改开合。允许 dockTabs 组 id（不在 ids 里也写）。 */
  focusPane(owner: string, paneId: string): void
  /** 归属消失（对话被删等）：清掉它那一份坞与前台 / 内容引用，并作废全屏。 */
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
 * `right.open` / `right.activeId` / `auxiliary.owner` 都是派生的，不单独记账：在场 = 前台那一份坞开着；
 * 活动格 = 前台那一份的选中格，不在场时恒为 null；内容归属见 {@link AuxiliaryState}。
 * 派生在一处算，不变量就不会因为某条写入路径忘了同步而破。
 */
function derive(state: LayoutState, panes: DockPanesState): LayoutState {
  const { activeOwner } = state.auxiliary
  const set = activeOwner === null ? undefined : panes.byOwner[activeOwner]
  const open = set?.open === true
  const activeId = open ? (set.activeId ?? null) : null
  const kept = state.auxiliary.owner
  const owner = open ? activeOwner : kept !== null && panes.byOwner[kept] !== undefined ? kept : null
  const fullscreen = open && state.auxiliary.fullscreen
  if (
    state.right.open === open &&
    state.right.activeId === activeId &&
    state.auxiliary.owner === owner &&
    state.auxiliary.fullscreen === fullscreen
  ) {
    return state
  }
  return {
    ...state,
    right: { ...state.right, open, activeId },
    auxiliary: { ...state.auxiliary, owner, fullscreen },
  }
}

export interface LayoutServiceOptions {
  /** 某块面板服务于哪一类归属；认不得的 id（还没贡献的面板）返回 undefined，按「不拦」处理，坞那一层再筛。 */
  readonly scopeOf?: (panelId: string) => PanelScope | undefined
}

export function createLayoutService(options: LayoutServiceOptions = {}): LayoutService {
  const v = createValue<LayoutState>(DEFAULT_LAYOUT)
  const panesValue = createValue<DockPanesState>({ byOwner: {} })

  /** 格清单与布局状态一起换：订阅者看不到「开合换了、格还没进去」的中间态。 */
  const commit = (state: LayoutState, panes: DockPanesState): void => {
    const next = derive(state, panes)
    if (panes !== panesValue.current()) panesValue.set(panes)
    if (next !== v.current()) v.set(next)
  }

  const update = (fn: (s: LayoutState) => LayoutState): void => {
    commit(fn(v.current()), panesValue.current())
  }

  const admits = (owner: string, paneId: string): boolean => {
    const scope = options.scopeOf?.(paneId)
    return scope === undefined || panelAdmits(scope, owner)
  }

  /** 改某个归属自己的那一份；fn 返回同一个对象即「没变」，不发通知。 */
  const updateSet = (owner: string, fn: (current: DockPaneSet | undefined) => DockPaneSet | undefined): void => {
    const panes = panesValue.current()
    const current = panes.byOwner[owner]
    const next = fn(current)
    if (next === current || next === undefined) return
    commit(v.current(), { byOwner: { ...panes.byOwner, [owner]: next } })
  }

  const openPane = (owner: string, paneId: string): void => {
    if (!admits(owner, paneId)) return
    updateSet(owner, (current) => {
      const alreadyOpen = current?.ids.includes(paneId) === true
      if (alreadyOpen && current.activeId === paneId && current.open) return current
      return { ids: alreadyOpen ? current.ids : [...(current?.ids ?? []), paneId], activeId: paneId, open: true }
    })
  }

  const closePane = (owner: string, paneId: string): void => {
    updateSet(owner, (current) => {
      if (current === undefined || !current.ids.includes(paneId)) return current
      const ids = current.ids.filter((id) => id !== paneId)
      /* 只有关掉的正是当前选中格才挪焦点（落到剩余最后一格，空则 null）；全空后坞回到启动器 —— 设置页没有启动器，直接收起。 */
      const activeId = current.activeId === paneId ? (ids.at(-1) ?? null) : current.activeId
      const open = current.open && !(ids.length === 0 && isSettingsDockOwner(owner))
      return { ids, activeId, open }
    })
  }

  const focusPane = (owner: string, paneId: string): void => {
    if (!admits(owner, paneId)) return
    updateSet(owner, (current) =>
      current?.activeId === paneId
        ? current
        : { ids: current?.ids ?? [], activeId: paneId, open: current?.open ?? false },
    )
  }

  const setDockOpen = (owner: string, open: boolean): void => {
    updateSet(owner, (current) => {
      if ((current?.open ?? false) === open) return current
      if (open && isSettingsDockOwner(owner) && (current?.ids.length ?? 0) === 0) return current
      return { ids: current?.ids ?? [], activeId: current?.activeId ?? null, open }
    })
  }

  const setActiveOwner = (owner: string | null): void => {
    const state = v.current()
    if (state.auxiliary.activeOwner === owner) return
    /* 前台换人 = 这一格离场：全屏瞬时态作废，各归属的开合与格清单原样保留。 */
    commit({ ...state, auxiliary: { ...state.auxiliary, activeOwner: owner, fullscreen: false } }, panesValue.current())
  }

  const forgetOwner = (owner: string): void => {
    const state = v.current()
    const panes = panesValue.current()
    const ownsFront = state.auxiliary.activeOwner === owner
    if (panes.byOwner[owner] === undefined && !ownsFront && state.auxiliary.owner !== owner) return
    const byOwner = { ...panes.byOwner }
    delete byOwner[owner]
    const auxiliary: AuxiliaryState = {
      ...state.auxiliary,
      activeOwner: ownsFront ? null : state.auxiliary.activeOwner,
      fullscreen: ownsFront ? false : state.auxiliary.fullscreen,
    }
    commit({ ...state, auxiliary }, { byOwner })
  }

  /* location 参数只有一个取值，留在签名里是为了调用点读起来仍是「哪一块坞」。 */
  const openPanel = (_location: 'right', panelId: string): void => {
    const owner = v.current().auxiliary.activeOwner
    if (owner === null) return
    openPane(owner, panelId)
  }

  const togglePanel = (_location: 'right', panelId?: string): void => {
    const state = v.current()
    const owner = state.auxiliary.activeOwner
    if (owner === null) return
    if (state.right.open && (panelId === undefined || state.right.activeId === panelId)) {
      setDockOpen(owner, false)
      return
    }
    if (panelId === undefined) {
      setDockOpen(owner, true)
      return
    }
    openPane(owner, panelId)
  }

  const closePanel = (_location: 'right'): void => {
    const owner = v.current().auxiliary.activeOwner
    if (owner !== null) setDockOpen(owner, false)
  }

  const setFullscreen = (fn: (current: boolean) => boolean): void => {
    const state = v.current()
    const fullscreen = fn(state.auxiliary.fullscreen)
    if (fullscreen === state.auxiliary.fullscreen) return
    commit({ ...state, auxiliary: { ...state.auxiliary, fullscreen } }, panesValue.current())
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
    setDockOpen,
    openPane,
    closePane,
    focusPane,
    forgetOwner,
    setAuxiliaryFullscreen: (fullscreen) => {
      setFullscreen(() => fullscreen)
    },
    toggleAuxiliaryFullscreen: () => {
      setFullscreen((current) => !current)
    },
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
      const sidebar = section(r.sidebar)
      const right = section(r.right)
      const auxiliary = section(r.auxiliary)
      /*
       * 存盘里只有「存盘那一刻坞里画的是谁、在不在场」：在场才给那一位补一条 open，格清单不落盘（再打开是启动器）。
       * 设置页（各页 `settings:<页 id>`）不补：技能文档那一格是随文档现开的瞬时格，重启后没有文档可看，补出来只是一块空白。
       * activeOwner 是运行期状态、由外壳按路由写；读盘是异步的，可能晚于外壳首次写前台，所以**保留**当前值而不是清空，
       * 否则启动后第一屏对话的坞要等换一次页才出来。存盘里没有 `auxiliary`（写坏了，或写到一半）时只恢复宽度。
       */
      const owner = str(auxiliary?.owner)
      const reopen = owner !== null && !isSettingsDockOwner(owner) && bool(right?.open, false)
      const panes = panesValue.current()
      const seeded = reopen
        ? {
            byOwner: {
              ...panes.byOwner,
              [owner]: {
                ids: panes.byOwner[owner]?.ids ?? [],
                activeId: panes.byOwner[owner]?.activeId ?? null,
                open: true,
              },
            },
          }
        : panes
      const state = v.current()
      commit(
        {
          sidebar: {
            visible: bool(sidebar?.visible, true),
            width: clamp(num(sidebar?.width, 280), LAYOUT_LIMITS.sidebar),
          },
          right: { ...state.right, size: clamp(num(right?.size, DEFAULT_LAYOUT.right.size), LAYOUT_LIMITS.right) },
          auxiliary: { owner: reopen ? owner : null, activeOwner: state.auxiliary.activeOwner, fullscreen: false },
        },
        seeded,
      )
    },
  }
}
