import { Button } from '@poietica/design-system'
import { ChevronLeft, ChevronRight, PanelLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { WindowControls } from '../../window/window-controls'
import { useWorkspaceLayoutState, useWorkspaceLayoutStore } from '../layout/layout-context'
import './title-bar.css'

const CHROME_BUTTON_CLASS =
  'size-[var(--titlebar-toggle-size)] shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'

export interface ActiveTabSequence {
  readonly canActivatePrevious: boolean
  readonly canActivateNext: boolean
  readonly activatePrevious: () => void
  readonly activateNext: () => void
}

export interface DesktopTitleBarProps {
  readonly children: ReactNode
  readonly activeTabSequence: ActiveTabSequence
  readonly onMinimize: () => void
  readonly onMaximize: () => void
  readonly onClose: () => void
  readonly isMaximized: boolean
}

export function DesktopTitleBar({
  children,
  activeTabSequence,
  onMinimize,
  onMaximize,
  onClose,
  isMaximized,
}: DesktopTitleBarProps) {
  const workspaceLayoutStore = useWorkspaceLayoutStore()

  const { sidebarOpen } = useWorkspaceLayoutState()

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 items-stretch bg-chrome">
      <div className="desktop-title-bar__toggle-zone desktop-title-bar__drag-region">
        <Button
          aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          className={CHROME_BUTTON_CLASS}
          onClick={workspaceLayoutStore.toggleSidebar}
          size="icon"
          type="button"
          variant="ghost"
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </Button>

        {sidebarOpen ? (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-2">
            <Button
              aria-label="切换到上一个标签页"
              className={CHROME_BUTTON_CLASS}
              disabled={!activeTabSequence.canActivatePrevious}
              onClick={activeTabSequence.activatePrevious}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>

            <Button
              aria-label="切换到下一个标签页"
              className={CHROME_BUTTON_CLASS}
              disabled={!activeTabSequence.canActivateNext}
              onClick={activeTabSequence.activateNext}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>

      <div className="desktop-title-bar__drag-region flex min-w-0 flex-1 items-stretch">
        {children}
      </div>

      <WindowControls
        isMaximized={isMaximized}
        onClose={onClose}
        onMaximize={onMaximize}
        onMinimize={onMinimize}
      />
    </div>
  )
}
