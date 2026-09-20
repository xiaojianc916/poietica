import { createMainWindowController } from '@poietica/native-bridge/window'
import { type ReactNode, useMemo } from 'react'
import { useWindowChrome } from '../window/use-window-chrome'
import { WindowControls } from '../window/window-controls'

export function FatalWindowFrame({ children }: { readonly children: ReactNode }) {
  const mainWindow = useMemo(() => createMainWindowController(), [])

  const { isMaximized, minimize, toggleMaximize, quit } = useWindowChrome(
    mainWindow,
    async () => undefined,
  )

  return (
    <>
      {/* WindowControls 必须是拖拽区（fatal-drag-region）的兄弟节点：落进拖拽区的命中会被 WebView2 按 caption 吞掉按钮 click。 */}
      <div className="fixed inset-x-0 top-0 z-[var(--ui-z-chrome)] flex h-8 items-stretch">
        <div className="fatal-drag-region h-full flex-1" />

        <WindowControls
          isMaximized={isMaximized}
          onClose={quit}
          onMaximize={toggleMaximize}
          onMinimize={minimize}
        />
      </div>

      {children}
    </>
  )
}
