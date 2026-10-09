import { createValue, type Observable } from './observable'

export interface PanelDockState {
  readonly open: boolean
  readonly activeId: string | null
  readonly size: number
}

/**
 * 右坞的归属状态。
 *
 * `owner` 是这一格归谁（哪条对话 / 设置页），由开格或坞的开关直接写；`activeOwner` 是
 * 当前前台是谁（表面在 effect 里声明）；`fullscreen` 是瞬时全屏态（不落盘）。两者相等
 * 且 owner 非空时右坞才在场 —— 就是 legacy 的 `auxiliaryThread === activeConversationId`。
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

/** 一个归属键下面开着的格（pane）与当前选中的那一格；activeId 允许是 dockTabs 组的 id。 */
export interface DockPaneSet {
  readonly ids: readonly string[]
  readonly activeId: string | null
}

/**
 * 各归属的格清单。
 *
 * **瞬时态、不落盘**：它不进 LayoutState，所以 preferences 把 layout.current() 整体存盘
 * 时不会带上它，restore 也不会写回来 —— 与 legacy 的 auxiliary-panel-store 同此（格按
 * 归属分账，只活在这一次运行里）。单独一个 Observable 是因为坞只订阅它：列宽每帧变时
 * 标签条不必跟着整棵外壳重画。
 */
export interface DockPanesState {
  readonly byOwner: Readonly<Record<string, DockPaneSet>>
}

/**
 * 默认布局与边界。
 *
 * 边界取 06 页 §6.2 的布局图（方案是权威）：侧栏 200–480、底部面板坞高 120–800、
 * 右侧面板坞宽 280–900。默认宽度取 legacy WORKSPACE_LAYOUT 的值（侧栏 280、
 * 辅助列 420、底部 280）—— 方案只给范围，默认值这一档以迁移来源为准。
 */
export const DEFAULT_LAYOUT: LayoutState = {
  sidebar: { visible: true, width: 280 },
  right: { open: false, activeId: null, size: 420 },
  auxiliary: { owner: null, activeOwner: null, fullscreen: false },
}
export const LAYOUT_LIMITS = {
  sidebar: [200, 480],
  right: [280, 900],
} as const

export type SplitterActivity = 'idle' | 'hover' | 'drag'
/**
 * 哪一条分隔条处于交互态。外壳只有两列一缝（侧栏 | 主区 | 辅助列），所以只有两档：
 * 侧栏右缘与辅助列左缘。legacy 的栅格同此，没有第三条可拖的边。
 */
export type SplitterRegion = 'sidebar' | 'auxiliary'

/**
 * 分隔条此刻的交互态。
 *
 * 它必须**可订阅**：外壳把这两个值写成根节点上的 `data-splitter` / `data-splitter-region`，
 * 而 CSS 的 `.workspace-shell[data-splitter="drag"] { transition: none }` 正是拖拽跟手的前提
 * （没有它，列宽会按 0.22s 插值走，指针一快主区就盖住侧栏）；悬停强调也读它。
 * 写成「渲染时调 splitter() 读瞬时变量」时，值变了没有任何人重画 —— 属性一直是 idle，
 * 悬停永远不亮、拖拽期的过渡也关不掉（真实故障）。
 *
 * 它一次拖拽只变两三次（进/悬停/松手），不进每帧路径，所以单独一个 Observable 足够。
 */
export interface SplitterState {
  readonly activity: SplitterActivity
  readonly region: SplitterRegion
}

export interface LayoutService extends Observable<LayoutState> {
  toggleSidebar(): void
  setSidebarWidth(px: number): void
  /**
   * 打开一个面板坞。
   *
   * 右坞的归属是**当前前台**（`auxiliary.activeOwner`）：入口页没有前台时命令不开坞
   * （legacy 同此）；打开即把该面板计入当前归属并选中。
   */
  openPanel(location: 'right', panelId: string): void
  togglePanel(location: 'right', panelId?: string): void
  closePanel(location: 'right'): void
  setPanelSize(location: 'right', px: number): void

  /** 各归属开着的格（pane）。瞬时态：不进 LayoutState，不落盘。 */
  readonly panes: Observable<DockPanesState>
  /** 当前前台归属（表面在 effect 里声明）。与坞的 owner 不一致即面板离场、全屏作废。 */
  setActiveOwner(owner: string | null): void
  /** 把坞认领给某个归属；传 null 收起。收起时全屏态一并作废。 */
  setAuxiliaryOwner(owner: string | null): void
  /** 开一格：追加（去重）并选中它，同时把坞的归属改到该 owner（不改 activeOwner）。 */
  openPane(owner: string, paneId: string): void
  /** 关一格：从清单移除；若关的是当前选中格，焦点落到剩余最后一格（空则 null）。 */
  closePane(owner: string, paneId: string): void
  /** 选中一格；允许 dockTabs 组 id（不在 ids 里也写）。 */
  focusPane(owner: string, paneId: string): void
  /** 选中某坞的活动格。右坞落在坞当前的 owner 上；owner 缺席时 no-op。 */
  setPanelActive(location: 'right', panelId: string | null): void
  /** 归属消失（对话被删等）：清掉它的格与坞 / 前台引用，并作废全屏。 */
  forgetOwner(owner: string): void
  setAuxiliaryFullscreen(fullscreen: boolean): void
  toggleAuxiliaryFullscreen(): void

  /** 分隔条的交互态：拖拽中不插值、悬停 50ms 后浮现（见 workbench 的 workspace-shell.css） */
  setSplitterActivity(activity: SplitterActivity, region: SplitterRegion): void
  splitter(): SplitterActivity
  splitterRegion(): SplitterRegion
  /** 交互态的可订阅视图：外壳的两条 data-* 属性读它 */
  readonly splitterState: Observable<SplitterState>
  /** 外壳宽度：辅助列的宽度上限要把它让出来 */
  setViewportWidth(width: number): void
  viewportWidth(): number | null
  /** preferences 恢复上次布局；非法值按默认值与边界修正 */
  restore(state: unknown): void
}

const clamp = (v: number, [min, max]: readonly [number, number]): number => Math.min(max, Math.max(min, Math.round(v)))

/**
 * `right.open` / `right.activeId` 是派生的，不单独记账：
 *
 * - 在场：坞有归属，且归属正是当前前台；
 * - 活动格：当前归属的格清单里的选中格（dockTabs 组 id 也在其中），不在场时恒为 null。
 *
 * 派生在一处算，不变量就不会因为某条写入路径忘了同步而破。
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

  /** 一次提交：格清单与布局状态一起换，订阅者看不到「归属换了、格还没进去」的中间态。 */
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
    /*
     * 关掉的正是当前选中格才挪焦点（落到剩余最后一格，空则 null）；关别处的格不动焦点，
     * 与 legacy resolved() 的「焦点还在就留着」同一条。全空之后 activeId 归 null，
     * 坞回到启动器。
     */
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
      /* 收起即离场：全屏是那一格此刻的瞬时态，面板不在了就作废（legacy 同此）。 */
      fullscreen: owner === null ? false : current.fullscreen,
    }))
  }

  const setActiveOwner = (owner: string | null): void => {
    updateAuxiliary((current) => ({
      ...current,
      activeOwner: owner,
      /* 前台换人 = 这一格离场：全屏瞬时态作废；owner 与格清单保留（legacy 的面板离场
       * 只作废全屏，不丢归属）。 */
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

  /*
   * 这几条方法的 location 参数保留在签名里（调用点读起来仍然是「哪一块坞」），
   * 但它只有一个取值：外壳只有右坞了，底坞已按产品负责人的要求整块删除。
   */
  const setPanelActive = (_location: 'right', panelId: string | null): void => {
    /* 右坞的活动格写在坞当前的归属上；没有归属就没有这一格可选。 */
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

  /*
   * 交互态自己一个 Observable（见 SplitterState 的头注）：它一次拖拽只变两三次，
   * 而外壳必须跟着它重画，否则 data-splitter 永远停在 idle。
   */
  const splitterValue = createValue<SplitterState>({ activity: 'idle', region: 'sidebar' })
  let splitter: SplitterActivity = 'idle'
  let splitterRegion: SplitterRegion = 'sidebar'
  /* 窗口宽度同理不进主 Observable：量窗口时重渲整棵外壳没有意义 */
  let viewportWidth: number | null = null

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
      // 一侧正在拖时，另一侧的悬停不夺焦点（legacy 的 activity() 同此）
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
      // 量不到就不设限：一个非有限的数会把整条上限算式变成 NaN
      if (!Number.isFinite(width)) return
      viewportWidth = Math.round(width)
    },
    viewportWidth: () => viewportWidth,
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
       * 兼容旧数据：旧形状只有 right.open / right.activeId，没有 auxiliary。归属只认
       * auxiliary.owner；activeOwner / fullscreen 是运行期状态，读盘时恒为 null / false
       * —— 右坞要不要在场由本次运行的前台表面说了算（restore 之后 surface 会 setActiveOwner）。
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
