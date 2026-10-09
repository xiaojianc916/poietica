import { Button, TooltipProvider } from '@poietica/design-system'
import { builtinPoints, FeatureScope, useContributions, useKernel, useLayout, useObservable } from '@poietica/ui-kernel'
import { PanelLeft, Search } from 'lucide-react'
import { type ReactNode, Suspense, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { auxiliaryMaxWidth } from './layout'
import { closePalette, openPalette, paletteSnapshot, subscribePalette } from './palette-state'
import { AuxiliaryDock } from './parts/auxiliary-dock'
import { CommandPalette } from './parts/command-palette'
import { ConfirmHost } from './parts/confirm-host'
import { MainArea } from './parts/main-area'
import { Overlays } from './parts/overlays'
import { PartSkeleton } from './parts/part-skeleton'
import { AuxiliaryRegion, SidebarRegion } from './parts/regions'
import { SettingsContentRegion, SettingsNavigation } from './parts/settings-regions'
import { SidebarFooter } from './parts/sidebar-footer'
import { Toasts } from './parts/toasts'
import { WorkspaceFrame } from './parts/workspace-frame'
import { WorkspaceSidebar } from './parts/workspace-sidebar'

/*
 * 外壳的按钮类。**迁移自** legacy `shell/chrome/title-bar.tsx` 的 CHROME_BUTTON_CLASS，
 * 一字未改（尺寸读 --titlebar-toggle-size，悬停用 sidebar-accent）。
 */
const CHROME_BUTTON_CLASS =
  'size-[var(--titlebar-toggle-size)] shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'

/**
 * 应用外壳。**迁移自** legacy `shell/layout/workspace-shell.tsx` +
 * `shell/chrome/title-bar.tsx` + `workbench/workspace.tsx` 的 isSettingsOpen 分支。
 *
 * 只换数据来源：宽度与开合读 ui-kernel 的 LayoutService，区域内容来自贡献点。
 */
export function Workbench(): ReactNode {
  const kernel = useKernel()
  const layout = useLayout()
  const paletteOpen = useSyncExternalStore(subscribePalette, paletteSnapshot)
  useObservable(kernel.kernelServices.coreStatus)

  const { sidebar, right, auxiliary } = layout
  const dockAuxiliary = right.open
  /* 全屏是「这一格此刻铺满主区」的瞬时态；坞不在场就不算数（legacy 的派生同此）。 */
  const isAuxiliaryFullscreen = dockAuxiliary && auxiliary.fullscreen
  /*
   * 设置打开时**外壳自己的区域换内容**（legacy workspace.tsx 的 isSettingsOpen 分支）：
   * 侧栏区放设置导航、主区放设置内容，右栏与页头不动。
   */
  const route = useObservable(kernel.kernelServices.navigation).route
  const isSettingsOpen = route.surface === 'workbench.settings'
  /*
   * 设置里换页时**路由参数**变、而 isSettingsOpen 不变：这两块内容要跟着参数重画，
   * 所以它进依赖数组。少了它，元素引用不变 → React 跳过子树 → 点了导航页不换（真实故障，
   * workbench.test.tsx 的「路由参数选中对应页」正是这条）。
   */
  const settingsPage = route.params.page ?? ''
  /* 交互态必须订阅着读：见 ui-kernel 的 SplitterState 头注（不订阅则 data-splitter 永远是 idle） */
  const splitterState = useObservable(kernel.kernelServices.layout.splitterState)
  const layoutService = kernel.kernelServices.layout
  /*
   * 打开设置时把辅助面板的归属切到设置那一格（legacy 的 workspace.tsx 在设置里把
   * auxiliaryThread 换成设置专用键）。**关闭时不写**：目标表面（对话 / 首页）自己声明
   * 当前前台，写在这里会与它的 effect 抢同一个值。
   */
  useEffect(() => {
    if (isSettingsOpen) layoutService.setActiveOwner('settings')
  }, [isSettingsOpen, layoutService])
  const toggleSidebar = useCallback(() => layoutService.toggleSidebar(), [layoutService])
  const resizeSidebar = useCallback((w: number) => layoutService.setSidebarWidth(w), [layoutService])
  const resizeAuxiliary = useCallback((w: number) => layoutService.setPanelSize('right', w), [layoutService])
  const closeAuxiliary = useCallback(() => layoutService.closePanel('right'), [layoutService])
  const onSidebarActivity = useCallback(
    (a: 'idle' | 'hover' | 'drag') => layoutService.setSplitterActivity(a, 'sidebar'),
    [layoutService],
  )
  const onAuxiliaryActivity = useCallback(
    (a: 'idle' | 'hover' | 'drag') => layoutService.setSplitterActivity(a, 'auxiliary'),
    [layoutService],
  )

  /*
   * 区域内容一律先建好、再交下去，**引用在列宽变化之间保持稳定**。
   *
   * 这是 legacy 的形状：它的 WorkspaceShell 收的是 `parts`（side bar content / main content
   * 都是预先建好的 ReactNode），所以拖拽时 store 每帧换宽度、外壳每帧重画，但**壳里的子树
   * 元素引用没变，React 直接跳过它们**。
   *
   * 反过来（把 <WorkspaceSidebar/> 之类内联写进 render）每一次宽度变化都会重建整棵子树：
   * 侧栏的线程列表、工作区选择器、主区的时间线全部跟着重渲染。拖得快时 React 追不上指针，
   * 列边界因此落在手后面 —— 屏幕上就是「主界面盖住侧栏、手感发涩」。真实故障。
   */
  const chrome = useMemo(
    () => (
      <header className="workspace-shell__chrome flex h-full min-h-0 w-full min-w-0 items-stretch bg-chrome">
        <TitleBar onOpenSearch={openPalette} sidebarOpen={sidebar.visible} toggleSidebar={toggleSidebar} />
      </header>
    ),
    [sidebar.visible, toggleSidebar],
  )
  /*
   * 浮层宿主**不占外壳栅格**（见 parts/overlays.tsx）：横幅改回 design-system 的通用
   * Banner，各功能自己 portal。它只负责「有没有一条要显示的浮层」和功能加载失败那一条。
   */
  const overlays = useMemo(() => <Overlays />, [])
  /*
   * 设置里侧栏那两段是**导航 + 底部行**（legacy workspace.tsx 的 isSettingsOpen 分支：
   * SettingsNavigationRegion 收了 footer=<SidebarFooter settingsActive />）。
   * 少了这枚 footer，打开设置后底部的「帮助 / 设置」两枚图标就整排消失（真实故障）。
   */
  const sidebarContent = useMemo(
    () =>
      isSettingsOpen ? (
        <SettingsNavigation footer={<SidebarFooter settingsActive />} page={settingsPage} />
      ) : (
        <WorkspaceSidebar />
      ),
    [isSettingsOpen, settingsPage],
  )
  const mainContent = useMemo(
    () => (isSettingsOpen ? <SettingsContentRegion params={{ page: settingsPage }} /> : <MainArea />),
    [isSettingsOpen, settingsPage],
  )
  const auxiliaryDock = useMemo(() => <AuxiliaryDock />, [])
  const mainControlItems = useContributions(builtinPoints.mainControls)
  /*
   * 主区 / 窗口右上角的会话控件（对话里的任务开关与辅助开关）由贡献点来，是外壳栅格的
   * 家具：wrapper 的 data-slot 决定落哪一格（见 styles.css），**不包容器**。
   *
   * 引用要稳：拖宽时 layout 每帧变、外壳每帧重画，这个元素引用不变，React 才会跳过
   * 控件子树（与上面几块的 useMemo 同一条理由）。
   */
  const mainControls = useMemo(
    () => (
      <>
        {[...mainControlItems]
          .sort((a, b) => a.item.order - b.item.order)
          .map((c) => (
            <div className="workspace-shell__conversation-control" data-slot={c.item.slot} key={c.item.id}>
              <FeatureScope featureId={c.featureId}>
                <Suspense fallback={<PartSkeleton />}>
                  <c.item.component />
                </Suspense>
              </FeatureScope>
            </div>
          ))}
      </>
    ),
    [mainControlItems],
  )
  useViewportWidth(kernel.kernelServices.layout)

  return (
    <TooltipProvider delay={450}>
      <WorkspaceFrame
        auxiliary={
          <AuxiliaryRegion
            fullscreen={isAuxiliaryFullscreen}
            isDocked={dockAuxiliary}
            maxWidth={auxiliaryMaxWidth({ sidebarOpen: sidebar.visible, sidebarWidth: sidebar.width })}
            onActivity={onAuxiliaryActivity}
            onClose={closeAuxiliary}
            onResize={resizeAuxiliary}
            width={right.size}
          >
            {auxiliaryDock}
          </AuxiliaryRegion>
        }
        auxiliaryColumnWidth={dockAuxiliary ? right.size : 0}
        chrome={chrome}
        isAuxiliaryDocked={dockAuxiliary}
        isAuxiliaryFullscreen={isAuxiliaryFullscreen}
        isSidebarDocked={sidebar.visible}
        main={
          <section
            aria-label="内容区"
            className="workspace-shell__main flex min-h-0 min-w-0 flex-col overflow-hidden bg-chrome"
          >
            <main className="workspace-shell__main-panel relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
              {mainContent}
            </main>
          </section>
        }
        mainControls={mainControls}
        overlays={overlays}
        sidebar={
          <SidebarRegion
            isDocked={sidebar.visible}
            onActivity={onSidebarActivity}
            onClose={toggleSidebar}
            onResize={resizeSidebar}
            width={sidebar.width}
          >
            {sidebarContent}
          </SidebarRegion>
        }
        sidebarColumnWidth={sidebar.visible ? sidebar.width : 0}
        splitter={splitterState.activity}
        splitterRegion={splitterState.region}
      />
      <CommandPalette
        onClose={() => {
          closePalette()
        }}
        open={paletteOpen}
      />
      <Toasts />
      <ConfirmHost />
    </TooltipProvider>
  )
}

interface TitleBarProps {
  readonly sidebarOpen: boolean
  readonly toggleSidebar: () => void
  readonly onOpenSearch: () => void
}

/**
 * 标题栏。**迁移自** legacy `DesktopTitleBar`：左端开合与搜索（在拖拽区内）、
 * 中段拖拽区、右端窗口按钮。legacy 的标签前后切换属于对话功能（P5 才回来），
 * 这里保留同一条 DOM 结构但中段暂时只放贡献点。
 */
function TitleBar({ sidebarOpen, toggleSidebar, onOpenSearch }: TitleBarProps): ReactNode {
  const centerItems = useContributions(builtinPoints.titleBarItems).filter((c) => c.item.align === 'center')
  const leftItems = useContributions(builtinPoints.titleBarItems).filter((c) => c.item.align === 'left')
  const rightItems = useContributions(builtinPoints.titleBarItems).filter((c) => c.item.align === 'right')
  return (
    <>
      <div className="desktop-title-bar__toggle-zone desktop-title-bar__drag-region" data-workbench-part="title-bar">
        <Button
          aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          className={CHROME_BUTTON_CLASS}
          onClick={toggleSidebar}
          size="icon"
          type="button"
          variant="ghost"
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </Button>
        <Button
          aria-label="搜索"
          className={CHROME_BUTTON_CLASS}
          onClick={onOpenSearch}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Search aria-hidden="true" className="size-4" />
        </Button>
        {leftItems.map((c) => (
          <FeatureScope featureId={c.featureId} key={c.item.id}>
            <Suspense fallback={<PartSkeleton />}>
              <c.item.component />
            </Suspense>
          </FeatureScope>
        ))}
      </div>
      <div
        className="desktop-title-bar__drag-region flex min-w-0 flex-1 items-stretch"
        data-workbench-part="title-bar-center"
      >
        {centerItems.map((c) => (
          <FeatureScope featureId={c.featureId} key={c.item.id}>
            <Suspense fallback={<PartSkeleton />}>
              <c.item.component />
            </Suspense>
          </FeatureScope>
        ))}
      </div>
      <div
        className="desktop-title-bar__drag-region ml-auto flex shrink-0 items-stretch"
        data-workbench-part="title-bar-end"
      >
        {rightItems.map((c) => (
          <FeatureScope featureId={c.featureId} key={c.item.id}>
            <Suspense fallback={<PartSkeleton />}>
              <c.item.component />
            </Suspense>
          </FeatureScope>
        ))}
      </div>
    </>
  )
}

/** 外壳有多宽交给 LayoutService：辅助列的宽度上限要把它让出来（见 auxiliaryMaxWidth）。 */
function useViewportWidth(layout: { setViewportWidth(w: number): void }): void {
  useEffect(() => {
    const root = document.documentElement
    const observer = new ResizeObserver(() => {
      layout.setViewportWidth(root.clientWidth)
    })
    layout.setViewportWidth(root.clientWidth)
    observer.observe(root)
    return () => {
      observer.disconnect()
    }
  }, [layout])
}
