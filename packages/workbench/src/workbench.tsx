import { Button, TooltipProvider } from '@poietica/design-system'
import { builtinPoints, FeatureScope, useContributions, useKernel, useLayout, useObservable } from '@poietica/ui-kernel'
import { PanelLeft, Search } from 'lucide-react'
import { type ReactNode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { closePalette, openPalette, paletteSnapshot, subscribePalette } from './palette-state'
import { AuxiliaryDock } from './parts/auxiliary-dock'
import { Banners } from './parts/banners'
import { CommandPalette } from './parts/command-palette'
import { ConfirmHost } from './parts/confirm-host'
import { MainArea } from './parts/main-area'
import { Overlays } from './parts/overlays'
import { PartSkeleton } from './parts/part-skeleton'
import { AuxiliaryRegion, SidebarRegion } from './parts/regions'
import { SettingsContentRegion, SettingsNavigation } from './parts/settings-regions'
import { SidebarFooter } from './parts/sidebar-footer'
import { WorkspaceFrame } from './parts/workspace-frame'
import { WorkspaceSidebar } from './parts/workspace-sidebar'

const CHROME_BUTTON_CLASS =
  'size-[var(--titlebar-toggle-size)] shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'

/** 应用外壳：宽度与开合读 LayoutService，区域内容来自贡献点。 */
export function Workbench(): ReactNode {
  const kernel = useKernel()
  const layout = useLayout()
  const paletteOpen = useSyncExternalStore(subscribePalette, paletteSnapshot)
  useObservable(kernel.kernelServices.coreStatus)

  const { sidebar, right, auxiliary } = layout
  const dockAuxiliary = right.open
  const isAuxiliaryFullscreen = dockAuxiliary && auxiliary.fullscreen
  /* 设置打开时外壳自己的区域换内容：侧栏区放设置导航、主区放设置内容，右栏与页头不动。 */
  const route = useObservable(kernel.kernelServices.navigation).route
  const isSettingsOpen = route.surface === 'workbench.settings'
  /*
   * 换页时路由参数变、isSettingsOpen 不变，所以 settingsPage 必须进依赖数组：少了它元素引用不变
   * → React 跳过子树 → 点了导航页不换（真实故障）。
   */
  const settingsPage = route.params.page ?? ''
  /* 交互态必须订阅着读：不订阅则 data-splitter 永远是 idle。 */
  const splitterState = useObservable(kernel.kernelServices.layout.splitterState)
  /* 列宽与分隔条范围只读有效几何：sidebar.width / right.size 是意图，放不下时画出来的会比它窄。 */
  const geometry = useObservable(kernel.kernelServices.layout.geometry)
  const layoutService = kernel.kernelServices.layout
  /* 打开设置时把辅助面板归属切到设置那一格。**关闭时不写**：目标表面自己声明当前前台，写在这里会与它的 effect 抢同一个值。 */
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
   * 区域内容一律先建好、再交下去，引用在列宽变化之间保持稳定。
   * 内联写进 render 会让每一次宽度变化都重建整棵子树（侧栏线程列表、工作区选择器、主区时间线），
   * 拖得快时 React 追不上指针，列边界落在手后面 —— 屏幕上就是「主界面盖住侧栏、手感发涩」（真实故障）。
   */
  const chrome = useMemo(
    () => (
      <header className="workspace-shell__chrome flex h-full min-h-0 w-full min-w-0 items-stretch bg-chrome">
        <TitleBar onOpenSearch={openPalette} sidebarOpen={sidebar.visible} toggleSidebar={toggleSidebar} />
      </header>
    ),
    [sidebar.visible, toggleSidebar],
  )
  /* 浮层宿主不占外壳栅格（见 parts/overlays.tsx）：横幅由各功能自己 portal，它只管功能加载失败那一条。 */
  const overlays = useMemo(() => <Overlays />, [])
  /* 设置里侧栏是「导航 + 底部行」；少了这枚 footer，打开设置后底部的「帮助 / 设置」两枚图标会整排消失（真实故障）。 */
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
   * 会话控件是外壳栅格的家具：wrapper 的 data-slot 决定落哪一格（见 styles.css），**不包容器**。
   * 引用要稳，理由与上面几块的 useMemo 相同。
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
            geometry={geometry.right}
            isDocked={dockAuxiliary}
            onActivity={onAuxiliaryActivity}
            onClose={closeAuxiliary}
            onResize={resizeAuxiliary}
          >
            {auxiliaryDock}
          </AuxiliaryRegion>
        }
        auxiliaryColumnWidth={geometry.right.column}
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
            geometry={geometry.sidebar}
            isDocked={sidebar.visible}
            onActivity={onSidebarActivity}
            onClose={toggleSidebar}
            onResize={resizeSidebar}
          >
            {sidebarContent}
          </SidebarRegion>
        }
        sidebarColumnWidth={geometry.sidebar.column}
        splitter={splitterState.activity}
        splitterRegion={splitterState.region}
      />
      <CommandPalette
        onClose={() => {
          closePalette()
        }}
        open={paletteOpen}
      />
      <Banners />
      <ConfirmHost />
    </TooltipProvider>
  )
}

interface TitleBarProps {
  readonly sidebarOpen: boolean
  readonly toggleSidebar: () => void
  readonly onOpenSearch: () => void
}

/** 标题栏：左端开合与搜索、中段拖拽区、右端窗口按钮。 */
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

/**
 * 外壳有多宽交给 LayoutService：两侧列要给主列地板让位（见 resolveLayoutGeometry）。
 * 首量放在 layout effect：赶在首帧绘制之前，否则先按「不设限」画一帧，再带着列宽过渡缩回去。
 */
function useViewportWidth(layout: { setViewportWidth(w: number): void }): void {
  useLayoutEffect(() => {
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
