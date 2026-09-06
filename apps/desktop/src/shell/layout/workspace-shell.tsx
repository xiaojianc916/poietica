import { TooltipProvider } from '@poietica/design-system'
import { encodeWorkbenchTabDomId } from '@poietica/workspace'
import { AuxiliaryRegion } from './auxiliary-region'
import { useWorkspaceLayoutState, useWorkspaceLayoutStore } from './layout-context'
import type { WorkspaceShellProps } from './shell-contract'
import { SidebarRegion } from './sidebar-region'
import { WorkspaceFrame } from './workspace-frame'

export function WorkspaceShell({ model, parts }: WorkspaceShellProps) {
  const workspaceLayoutStore = useWorkspaceLayoutStore()

  const { sidebarOpen, sidebarWidth, auxiliaryWidth, splitter, splitterRegion } =
    useWorkspaceLayoutState()
  const { setSidebarOpen, setSidebarWidth, setAuxiliaryThread, setAuxiliaryWidth } =
    workspaceLayoutStore
  const dockAuxiliary = parts.auxiliary.isDocked

  const activeTabDomId = encodeWorkbenchTabDomId(model.activeTabId)

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
