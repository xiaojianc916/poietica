import { TooltipProvider } from '@poietica/design-system'
import { auxiliaryMaxWidth } from '@poietica/workspace'
import { useEffect } from 'react'
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
    viewportWidth,
  } = useWorkspaceLayoutState()
  const { setSidebarOpen, setSidebarWidth, setAuxiliaryThread, setAuxiliaryWidth } =
    workspaceLayoutStore
  const dockAuxiliary = parts.auxiliary.isDocked
  const auxiliaryFullscreenActive = auxiliaryFullscreen && dockAuxiliary

  useViewportWidth(workspaceLayoutStore.setViewportWidth)

  /*
   * 面板不在场，全屏态就得作废 —— 写回 store，不是只在这里遮蔽。
   *
   * 全屏是「这一格此刻铺满主区」的瞬时态，而面板收起的路不止一条：关掉它、切到另一条
   * 对话，都会让这一格离场。只做派生遮蔽的话 store 里那个 true 一直活着，面板重新打开
   * 就带着上一次的全屏回来，用户从没要求过。写回之后这里与 AuxiliaryDock 读到的是同
   * 一个值，不再是一个 flag 两个读者。
   */
  useEffect(() => {
    if (!auxiliaryFullscreenActive) {
      workspaceLayoutStore.setAuxiliaryFullscreen(false)
    }
  }, [auxiliaryFullscreenActive, workspaceLayoutStore.setAuxiliaryFullscreen])

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
            maxWidth={auxiliaryMaxWidth({ sidebarOpen, sidebarWidth, viewportWidth })}
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

/*
 * 外壳有多宽，交给 store 一处保管：辅助列的宽度上限要把它让出来（见
 * auxiliaryMaxWidth），不然拖过某个宽度之后三列之和超过外壳，栅格溢出被裁掉。
 *
 * 量根元素而不是外壳自己的盒子：外壳是 w-full 的整窗元素，两者恒等，而根元素不需要
 * 一个 ref 穿过 WorkspaceFrame。ResizeObserver 而不是 resize 事件：前者在尺寸真的
 * 变了才报，窗口拖动期间不按帧刷。
 */
function useViewportWidth(publish: (width: number) => void): void {
  useEffect(() => {
    const root = document.documentElement
    const observer = new ResizeObserver(() => {
      publish(root.clientWidth)
    })

    publish(root.clientWidth)
    observer.observe(root)

    return () => {
      observer.disconnect()
    }
  }, [publish])
}
