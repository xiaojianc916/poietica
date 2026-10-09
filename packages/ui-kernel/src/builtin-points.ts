import type { ComponentType, LazyExoticComponent, ReactNode } from 'react'
import { defineContributionPoint } from './contribution'

export type SurfaceComponent<P = Record<string, never>> = ComponentType<P> | LazyExoticComponent<ComponentType<P>>
export type IconComponent = ComponentType<{ className?: string }>

export interface CommandItem {
  /** '<功能 id>.<动作>'，例如 'terminal.new' */
  readonly id: string
  readonly title: string
  readonly category?: string
  readonly run: (args?: unknown) => void | Promise<void>
  readonly enabled?: () => boolean
  /** true：不出现在命令面板（仍可被快捷键或代码执行） */
  readonly hidden?: boolean
}
export interface KeybindingItem {
  readonly command: string
  /** 规范写法：'Ctrl+Shift+P'、'Ctrl+`'、'Escape' */
  readonly key: string
  readonly when?: () => boolean
}
export interface SurfaceItem {
  /** 路由里的 surface，例如 'conversation.thread' */
  readonly id: string
  readonly title: string
  readonly component: SurfaceComponent<{ params: Readonly<Record<string, string>> }>
}
export interface SidebarSectionItem {
  readonly id: string
  readonly order: number
  readonly title: string
  /** 导航行首的图标；省略时 workbench 用一枚占位图标 */
  readonly icon?: IconComponent
  readonly component: SurfaceComponent
  /**
   * 这一条落在侧栏的哪一格。
   *
   * legacy 的侧栏是固定三段：顶部导航（新建对话 / 自动化）、中部面板（会话列表）、
   * 底部行。03 页 §4 的 `sidebarSections` 只说了「左侧栏」，没有区分导航与面板，
   * 而两个贡献者的形态天然不同 —— automations 的是一枚导航行、conversation 的是一整块
   * 面板。缺省 `panel`（与旧行为一致），`nav` 的条目排进顶部导航区。
   */
  readonly placement?: 'nav' | 'panel'
}
/**
 * 坞标签条里的一格。一个面板自身一格，或 dockTabs 贡献的一组动态标签里的一格
 * （浏览器标签就是后者）。与 legacy 的 DockPaneView 同形：字形 + 名字 + 是否选中。
 */
export interface DockTabDescriptor {
  readonly id: string
  readonly title: string
  readonly icon: ReactNode
  readonly active: boolean
}

/**
 * 一个面板贡献的动态标签组。
 *
 * 只有「一组标签共用一个面板」的面板才需要它：浏览器的标签数量随宿主增减，不是贡献点
 * 里能列出来的静态面板。坞把 `tabs()` 与已开 pane 画进同一条标签条，选中 / 关闭 / 新开
 * 都回到贡献方自己的动作上（浏览器标签的真相在浏览器宿主里）。
 */
export interface PanelDockTabs {
  subscribe(listener: () => void): () => void
  tabs(): readonly DockTabDescriptor[]
  onSelect(tabId: string): void
  onClose(tabId: string): void
  onOpen(): void
}

/**
 * 主区 / 窗口右上角的会话控件（对话里的任务开关、辅助面板开关）。
 *
 * 它们不画进主区面板里面，是外壳栅格的家具：`slot: 'main'` 钉在主区那一列右缘，
 * `slot: 'window'` 横跨三列贴窗口右缘（legacy workspace-shell.css 的
 * `.workspace-shell__todo-control` / `.workspace-shell__auxiliary-toggle`）。组件只出
 * 内容，定位由 workbench 的包装层负责。
 */
export interface MainControlItem {
  readonly id: string
  readonly order: number
  readonly slot: 'main' | 'window'
  readonly component: SurfaceComponent
}

/**
 * 一块可以放进外壳右坞的面板。
 *
 * `location` 只剩 `right` 一档：**legacy 的栅格里没有底坞**（它的 dock 只有右栏那一列，
 * 终端 / 审查 / 浏览器 / 辅助对话都是那一列里的格子）。新架构早先照 06 页 §6.2 的布局图
 * 做了个底部面板坞，产品负责人 2026-10-07 明确「这个设计不要了」—— 底坞连同它的状态、
 * 命令、样式与贡献点取值一起删除，终端回到右栏（见 docs/refactor-log.md 的偏差记录）。
 */
export interface PanelItem {
  readonly id: string
  readonly location: 'right'
  readonly order: number
  readonly title: string
  readonly icon: IconComponent
  readonly component: SurfaceComponent
  /** 是否出现在坞的启动器里；缺省 true。只能由代码打开的格（如技能文档）写 false。 */
  readonly offer?: boolean
  /** 启动器里的一行说明；缺省不画说明行。 */
  readonly description?: string
  /** 由这一格代画的动态页签（如浏览器标签）；缺省没有。 */
  readonly dockTabs?: PanelDockTabs
}
export interface SettingsPageItem {
  readonly id: string
  /**
   * 落在哪一段（`settingsGroups` 里某一段的 id，通常是 `SETTINGS_GROUPS` 的三段之一）。
   * 找不到对应段时归入末尾的兜底段（06 页 §6.2）。
   */
  readonly group: string
  readonly order: number
  readonly title: string
  readonly icon: IconComponent
  readonly component: SurfaceComponent
}

/**
 * 设置导航的一段。段与段之间只有间距、没有标题（与 legacy `settings-surface.tsx`
 * 的 `SECTION_GROUPS` 一致：`.settings-navigation__items + .settings-navigation__items`
 * 那条 `margin-block-start` 就是它）。
 */
export interface SettingsGroupItem {
  readonly id: string
  readonly order: number
}

/** 三个标准段的 id。功能写 `settingsPages.group` 时引用这里的常量。 */
export const SETTINGS_GROUPS = { app: 'app', agent: 'agent', system: 'system' } as const

/**
 * 设置页**内部**的一段（组）。
 *
 * `settingsPages` 只能整页地往导航里加一格；而 legacy 的通用页里住着 Python 内核那一组、
 * 关于页里住着「诊断与更新」那一组 —— 它们是别的功能的界面，却画在别人的页上。让 python
 * 或 update 各占一整页会把导航撑出一堆只含一格的页面（07 页 §13G 与 §15E 的原设计如此，
 * 产品负责人 2026-10-06 改成「并入通用 / 并入关于」）。
 *
 * `page` 是设置页 id 的**纯字符串**（`'preferences.general'` / `'platform.about'`）：
 * 跨功能协作只经过贡献点，页面宿主 `useContributions` 后按 `page` 过滤，因此不产生任何
 * 功能之间的 import（守则 3）。
 */
export interface SettingsSectionItem {
  readonly id: string
  readonly order: number
  /** 落在哪一页：设置页的 id，例如 'preferences.general' */
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
 * 侧栏底部帮助菜单里的一行。
 *
 * legacy 的 `SidebarFooter` 收一个 `updateRow` ReactNode（`app-shell.tsx` 传入
 * `<UpdateRow store={updates} />`）；新架构里外壳不认识功能，这个位置就换成贡献点
 * —— update 功能贡献「检查更新」那一行。渲染位置固定在「项目文档」与「GitHub」之间
 * （legacy 的次序）。
 */
export interface HelpMenuItem {
  readonly id: string
  readonly order: number
  readonly component: SurfaceComponent
}
/**
 * 新对话界面里的提示：画在吉祥物**上方**，与它同处一块版心。
 *
 * 它属于那一块版心，不该把整屏往下推一行。产品负责人（2026-10-05）明确要求落到吉祥物
 * 上方。
 *
 * 这里原先是「为什么单开一个点而不是复用 banners」—— 那条横幅区（外壳栅格里的**一整行**）
 * 已按产品负责人 2026-10-06 的要求整条删除，见下面 builtinPoints 的说明。
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
 * 浮层贡献点：画在页面**之上**的浮层（自己 portal 到 body、自己定位）。
 *
 * 它不占外壳栅格的任何一格。外壳栅格只有两行（页头 / 主体，与 legacy 同形）——
 * 原先那条「横幅行」是迁移时自己加的第三行，退出时会闪一条没有字的 `--ui-accent`
 * 色块，产品负责人 2026-10-06 要求整条删除，横幅改回 design-system 的通用 Banner
 * （portal 浮层形态，legacy 就是这么用的）。
 *
 * 与 entryNotices 同形：useVisible 是个 Hook，由消费方在组件里调。
 */
export interface OverlayItem {
  readonly id: string
  readonly order: number
  readonly component: SurfaceComponent
  /** 由组件内部的状态决定是否显示：返回 false 时不渲染 */
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
  /** 设置页内部的段（组）：见 SettingsSectionItem 的说明 */
  settingsSections: defineContributionPoint<SettingsSectionItem>('workbench.settingsSections'),
  statusItems: defineContributionPoint<StatusItem>('workbench.statusItems'),
  titleBarItems: defineContributionPoint<TitleBarItem>('workbench.titleBarItems'),
  /** 帮助菜单里的行（「项目文档」与「GitHub」之间）：见 HelpMenuItem 的说明 */
  helpMenuItems: defineContributionPoint<HelpMenuItem>('workbench.helpMenuItems'),
  /** 入口界面的提示（新对话页） */
  entryNotices: defineContributionPoint<EntryNoticeItem>('workbench.entryNotices'),
  /** 页面之上的浮层（自己定位，不占栅格） */
  overlays: defineContributionPoint<OverlayItem>('workbench.overlays'),
} as const
