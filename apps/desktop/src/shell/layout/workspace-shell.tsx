import { TooltipProvider } from '@poietica/design-system'
import { auxiliaryMaxWidth } from '@poietica/workspace'
import { AuxiliaryRegion } from './auxiliary-region'
import { useWorkspaceLayoutState, useWorkspaceLayoutStore } from './layout-context'
import type { WorkspaceShellProps } from './shell-contract'
import { SidebarRegion } from './sidebar-region'
import { WorkspaceFrame } from './workspace-frame'

export function WorkspaceShell({ parts }: WorkspaceShellProps) {
  const workspaceLayoutStore = useWorkspaceLayoutStore()

  const {
    sidebarOpen,
    sidebarWidth,
    auxiliaryWidth,
    splitter,
    splitterRegion,
    auxiliaryFullscreen,
  } = useWorkspaceLayoutState()
  const { setSidebarOpen, setSidebarWidth, setAuxiliaryThread, setAuxiliaryWidth } =
    workspaceLayoutStore
  const dockAuxiliary = parts.auxiliary.isDocked
  /* 面板不在场时全屏同步失效：再次停靠前不继承上次的全屏态。 */
  const auxiliaryFullscreenActive = auxiliaryFullscreen && dockAuxiliary

  const closeAuxiliary =
    parts.auxiliary.onClose ??
    (() => {
      setAuxiliaryThread(null)
    })

  return (
    <TooltipProvider delay={450}>
      <WorkspaceFrame
        auxiliary={
          <AuxiliaryRegion
            fullscreen={auxiliaryFullscreenActive}
            isDocked={dockAuxiliary}
            maxWidth={auxiliaryMaxWidth({ sidebarOpen, sidebarWidth })}
            onClose={closeAuxiliary}
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
        isAuxiliaryFullscreen={auxiliaryFullscreenActive}
        isSidebarDocked={sidebarOpen}
        main={
          /* 栅格格位铺 chrome 地色，面板自己铺页面底色并带四角圆角、右与下各留一条
           * 留白：圆角缺口与留白里露出来的就是这一格的地色。见 workspace-shell.css。 */
          <section
            aria-label="内容区"
            className="workspace-shell__main min-h-0 min-w-0 overflow-hidden bg-chrome"
          >
            <main
              aria-label={parts.main.label}
              className="workspace-shell__main-panel relative h-full min-h-0 min-w-0 overflow-hidden bg-background"
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
