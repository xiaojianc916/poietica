import { TooltipProvider } from '@poietica/ui'

import type { WorkspaceShellProps } from '../shell-contract'
import { BrowserRegion } from './browser-region'
import { SidebarRegion } from './sidebar/sidebar-region'
import { useIsSidebarDocked } from './sidebar-docking'
import { encodeWorkbenchTabDomId } from './workbench-tabs/workbench-tabs-model'
import { WorkspaceFrame } from './workspace-frame'
import { useWorkspaceLayoutState, workspaceLayoutStore } from './workspace-layout-store'

/**
 * 工作区外壳。
 *
 * 职责只有一件：把布局意图翻译成停靠状态位，并把 Part 表装进 WorkspaceFrame。
 * 栅格坐标属于 workspace-shell.css，区域内部形态属于区域组件，
 * 布局意图与拖拽态属于 workspaceLayoutStore。
 */
export function WorkspaceShell({ model, parts }: WorkspaceShellProps) {
  const { sidebarWidth, browserOpen, browserWidth, splitter, splitterRegion } =
    useWorkspaceLayoutState()
  const { setSidebarOpen, setSidebarWidth, setBrowserOpen, setBrowserWidth } = workspaceLayoutStore

  /* 停靠是呈现判据：列宽与分隔线的可见性都由它派生。 */
  const dockSidebar = useIsSidebarDocked()
  const activeTabDomId = encodeWorkbenchTabDomId(model.activeTabId)

  /*
   * 主区默认是标签面板，由标签自己命名（aria-labelledby）；只有 Part 明确给了
   * label 时才降级成 region 并自带名字。两者互斥，不能同时挂。
   */
  const isTabPanel = parts.main.label === undefined

  return (
    <TooltipProvider delay={450}>
      <WorkspaceFrame
        browser={
          <BrowserRegion
            isDocked={browserOpen}
            onClose={() => {
              setBrowserOpen(false)
            }}
            onResize={setBrowserWidth}
            width={browserWidth}
          >
            {parts.browser.content}
          </BrowserRegion>
        }
        browserColumnWidth={browserOpen ? browserWidth : 0}
        chrome={
          <header className="workspace-shell__chrome min-h-0 min-w-0 bg-chrome">
            {parts.chrome.content}
          </header>
        }
        isBrowserDocked={browserOpen}
        isSidebarDocked={dockSidebar}
        main={
          <section
            aria-label="内容区"
            className="workspace-shell__main min-h-0 min-w-0 overflow-hidden bg-background"
          >
            <main
              aria-label={parts.main.label}
              aria-labelledby={isTabPanel ? `workbench-tab-${activeTabDomId}` : undefined}
              className="relative h-full min-h-0 min-w-0 overflow-hidden"
              id={isTabPanel ? `workbench-panel-${activeTabDomId}` : undefined}
              role={isTabPanel ? 'tabpanel' : 'region'}
            >
              {parts.main.content}
            </main>
          </section>
        }
        sidebar={
          <SidebarRegion
            isDocked={dockSidebar}
            onClose={() => {
              setSidebarOpen(false)
            }}
            onResize={setSidebarWidth}
            width={sidebarWidth}
          >
            {parts.sidebar.content}
          </SidebarRegion>
        }
        sidebarColumnWidth={dockSidebar ? sidebarWidth : 0}
        splitter={splitter}
        splitterRegion={splitterRegion}
      />
    </TooltipProvider>
  )
}
