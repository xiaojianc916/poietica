import { TooltipProvider } from '@poietica/design-system'
import { encodeWorkbenchTabDomId } from '@poietica/workspace'
import { AuxiliaryRegion } from './auxiliary/auxiliary-region'
import type { WorkspaceShellProps } from './shell-contract'
import { SidebarRegion } from './sidebar/sidebar-region'
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
  const { sidebarOpen, sidebarWidth, auxiliaryWidth, splitter, splitterRegion } =
    useWorkspaceLayoutState()
  const { setSidebarOpen, setSidebarWidth, setAuxiliaryThread, setAuxiliaryWidth } =
    workspaceLayoutStore
  const dockAuxiliary = parts.auxiliary.isDocked

  const activeTabDomId = encodeWorkbenchTabDomId(model.activeTabId)

  /*
   * 主区默认是标签面板，由标签自己命名（aria-labelledby）；只有 Part 明确给了
   * label 时才降级成 region 并自带名字。两者互斥，不能同时挂。
   */
  const isTabPanel = parts.main.label === undefined

  return (
    <TooltipProvider delay={450}>
      <WorkspaceFrame
        auxiliary={
          <AuxiliaryRegion
            isDocked={dockAuxiliary}
            onClose={() => {
              setAuxiliaryThread(null)
            }}
            onResize={setAuxiliaryWidth}
            width={auxiliaryWidth}
          >
            {parts.auxiliary.content}
          </AuxiliaryRegion>
        }
        auxiliaryColumnWidth={dockAuxiliary ? auxiliaryWidth : 0}
        chrome={
          <header className="workspace-shell__chrome min-h-0 min-w-0 bg-chrome">
            {parts.chrome.content}
          </header>
        }
        isAuxiliaryDocked={dockAuxiliary}
        isSidebarDocked={sidebarOpen}
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
        mainControls={parts.main.controls}
        sidebar={
          <SidebarRegion
            isDocked={sidebarOpen}
            onClose={() => {
              setSidebarOpen(false)
            }}
            onResize={setSidebarWidth}
            width={sidebarWidth}
          >
            {parts.sidebar.content}
          </SidebarRegion>
        }
        sidebarColumnWidth={sidebarOpen ? sidebarWidth : 0}
        splitter={splitter}
        splitterRegion={splitterRegion}
      />
    </TooltipProvider>
  )
}
