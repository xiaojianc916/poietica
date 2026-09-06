import { createMainWindowController } from '@poietica/native-bridge/window'
import { type ReactNode, useMemo } from 'react'
import { useWindowChrome } from '../window/use-window-chrome'
import { WindowControls } from '../window/window-controls'

/*
 * 崩溃屏自己建 controller，不从 runtime 取：native-crash 那条启动路径上
 * runtime 从未被创建，而这个 controller 不持状态，每个方法现取窗口。退出前也
 * 没有可清理的应用资源，dispose 传空实现。
 */
export function FatalWindowFrame({ children }: { readonly children: ReactNode }) {
  const mainWindow = useMemo(() => createMainWindowController(), [])

  const { isMaximized, minimize, toggleMaximize, quit } = useWindowChrome(
    mainWindow,
    async () => undefined,
  )

  return (
    <>
      {/*
       * 覆盖在客户区之上的非客户区，和原生 caption 一样：不介入内容自己的
       * 布局，居中内容原样不动。
       *
       * 填充区挂 fatal-drag-region，走 WebView2 原生可拖拽区域：拖动与双击
       * 最大化由系统非客户区处理。WindowControls 是填充区的兄弟节点，天然在
       * 拖拽区外——caption 命中会吞掉按钮的 click。
       */}
      <div className="fixed inset-x-0 top-0 z-50 flex h-8 items-stretch">
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
