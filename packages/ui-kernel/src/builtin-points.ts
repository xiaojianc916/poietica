import type { ComponentType, LazyExoticComponent, ReactNode } from 'react'
import { defineContributionPoint } from './contribution'
import type { PanelScope } from './services/layout'

export type SurfaceComponent<P = Record<string, never>> = ComponentType<P> | LazyExoticComponent<ComponentType<P>>
export type IconComponent = ComponentType<{ className?: string }>

export interface CommandItem {
  readonly id: string
  readonly title: string
  readonly category?: string
  readonly run: (args?: unknown) => void | Promise<void>
  readonly enabled?: () => boolean
  /** 不出现在命令面板，仍可被快捷键或代码执行。 */
  readonly hidden?: boolean
}
export interface KeybindingItem {
  readonly command: string
  readonly key: string
  readonly when?: () => boolean
}
export interface SurfaceItem {
  readonly id: string
  readonly title: string
  readonly component: SurfaceComponent<{ params: Readonly<Record<string, string>> }>
  /**
   * 这一页的右坞归谁（布局服务的 activeOwner）。缺省即「没有归属」：这一页上不画右坞，开格命令也不开。
   * 由外壳按路由统一写这一个值 —— 以前是各表面在自己的 effect 里写、设置页由外壳另写，两个写者抢同一个值，
   * 没写的表面（自动化、代码审查）还会沿用上一页对话的坞。
   */
  readonly dockOwner?: (params: Readonly<Record<string, string>>) => string | null
}
export interface SidebarSectionItem {
  readonly id: string
  readonly order: number
  readonly title: string
  /** 省略时 workbench 用一枚占位图标。 */
  readonly icon?: IconComponent
  readonly component: SurfaceComponent
  /**
   * 这一条落在侧栏的哪一格：`nav` 排进顶部导航区，缺省 `panel` 落中部面板那一格（导航行与整块面板形态不同）。
   */
  readonly placement?: 'nav' | 'panel'
}
/** 坞标签条里的一格：一个面板自身一格，或是 dockTabs 那组动态标签里的一格。 */
export interface DockTabDescriptor {
  readonly id: string
  readonly title: string
  readonly icon: ReactNode
  readonly active: boolean
}

/**
 * 一个面板贡献的动态标签组。只有「一组标签共用一个面板」才需要它：标签数量随宿主增减，列不进静态贡献点。
 * 坞把 `tabs()` 与已开 pane 画进同一条标签条，选中 / 关闭 / 新开都回到贡献方自己的动作上。
 */
export interface PanelDockTabs {
  subscribe(listener: () => void): () => void
  tabs(): readonly DockTabDescriptor[]
  onSelect(tabId: string): void
  onClose(tabId: string): void
  onOpen(): void
}

/**
 * 主区 / 窗口右上角的会话控件。它们不画进主区面板里面，是外壳栅格的家具：
 * `slot: 'main'` 钉在主区那一列右缘，`slot: 'window'` 横跨三列贴窗口右缘；组件只出内容，定位由 workbench 的包装层负责。
 */
export interface MainControlItem {
  readonly id: string
  readonly order: number
  readonly slot: 'main' | 'window'
  readonly component: SurfaceComponent
}

/**
 * 一块可以放进外壳右坞的面板。`location` 只剩 `right` 一档 —— 早先照布局图做过的底部面板坞已按产品负责人
 * 2026-10-07 的决定连同状态、命令、样式一起删除（见 docs/refactor-log.md 的偏差记录）。
 */
export interface PanelItem {
  readonly id: string
  readonly location: 'right'
  readonly order: number
  readonly title: string
  readonly icon: IconComponent
  readonly component: SurfaceComponent
  /** 缺省 true；只能由代码打开的格写 false，不出现在启动器里。 */
  readonly offer?: boolean
  readonly description?: string
  readonly dockTabs?: PanelDockTabs
  /**
   * 服务于哪一位归属，缺省 `surface`（普通表面）。写 `settingsDockOwner('<设置页 id>')` 的格只在设置里的**那一页**出现，
   * 设置页的坞也只画属于自己那一页的格（不画标签条）。
   */
  readonly scope?: PanelScope
}
export interface SettingsPageItem {
  readonly id: string
  /** 落在哪一段（`settingsGroups` 里某一段的 id）；找不到对应段时归入末尾的兜底段。 */
  readonly group: string
  readonly order: number
  readonly title: string
  readonly icon: IconComponent
  readonly component: SurfaceComponent
}

/** 设置导航的一段：段与段之间只有间距、没有标题。 */
export interface SettingsGroupItem {
  readonly id: string
  readonly order: number
}

/** 功能写 `settingsPages.group` 时引用这里的常量。 */
export const SETTINGS_GROUPS = { app: 'app', agent: 'agent', system: 'system' } as const

/**
 * 设置页**内部**的一段（组）：`settingsPages` 只能整页地往导航里加一格，而有些功能的界面画在别人的页上
 * （让它们各占一整页会把导航撑出一堆只含一格的页面）。
 * `page` 是设置页 id 的**纯字符串**：跨功能协作只经贡献点，页面宿主按 `page` 过滤，不产生功能之间的 import。
 */
export interface SettingsSectionItem {
  readonly id: string
  readonly order: number
  readonly page: string
  readonly component: SurfaceComponent
}
export interface StatusItem {
  readonly id: string
  readonly align: 'left' | 'right'
  readonly order: number
  readonly component: SurfaceComponent
}
export interface TitleBarItem {
  readonly id: string
  readonly align: 'left' | 'center' | 'right'
  readonly order: number
  readonly component: SurfaceComponent
}
/**
 * 侧栏底部帮助菜单里的一行。渲染位置固定在「项目文档」与「GitHub」之间 ——
 * 外壳不认识功能，这个原先由宿主传入插槽的位置就换成了贡献点。
 */
export interface HelpMenuItem {
  readonly id: string
  readonly order: number
  readonly component: SurfaceComponent
}
/**
 * 新对话界面里的提示：画在吉祥物**上方**，与它同处一块版心，不该把整屏往下推一行（产品负责人 2026-10-05 明确要求）。
 * useVisible 是个 Hook，由消费方在组件里调。
 */
export interface EntryNoticeItem {
  readonly id: string
  readonly order: number
  readonly component: SurfaceComponent
  /** 由组件内部的状态决定是否显示：返回 false 时不渲染 */
  readonly useVisible: () => boolean
}

/**
 * 浮层贡献点：画在页面**之上**（自己 portal 到 body、自己定位），不占外壳栅格的任何一格 ——
 * 外壳栅格只有两行，原先那条「横幅行」是迁移时自己加的第三行，退出时会闪一条没有字的色块，已整条删除。
 * 与 entryNotices 同形：useVisible 是个 Hook，由消费方在组件里调。
 */
export interface OverlayItem {
  readonly id: string
  readonly order: number
  readonly component: SurfaceComponent
  readonly useVisible: () => boolean
}

export const builtinPoints = {
  commands: defineContributionPoint<CommandItem>('workbench.commands'),
  keybindings: defineContributionPoint<KeybindingItem>('workbench.keybindings'),
  surfaces: defineContributionPoint<SurfaceItem>('workbench.surfaces'),
  sidebarSections: defineContributionPoint<SidebarSectionItem>('workbench.sidebarSections'),
  panels: defineContributionPoint<PanelItem>('workbench.panels'),
  mainControls: defineContributionPoint<MainControlItem>('workbench.mainControls'),
  settingsPages: defineContributionPoint<SettingsPageItem>('workbench.settingsPages'),
  settingsGroups: defineContributionPoint<SettingsGroupItem>('workbench.settingsGroups'),
  settingsSections: defineContributionPoint<SettingsSectionItem>('workbench.settingsSections'),
  statusItems: defineContributionPoint<StatusItem>('workbench.statusItems'),
  titleBarItems: defineContributionPoint<TitleBarItem>('workbench.titleBarItems'),
  helpMenuItems: defineContributionPoint<HelpMenuItem>('workbench.helpMenuItems'),
  entryNotices: defineContributionPoint<EntryNoticeItem>('workbench.entryNotices'),
  overlays: defineContributionPoint<OverlayItem>('workbench.overlays'),
} as const
