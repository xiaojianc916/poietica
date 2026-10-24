import type { Disposable } from '@poietica/foundation'
import type { MenuItemConstructorOptions, Tray } from 'electron'

type TrayPort = Pick<Tray, 'destroy' | 'popUpContextMenu' | 'setContextMenu'> & {
  on(event: 'click' | 'right-click', listener: () => void): unknown
}

export function createTray(d: {
  icon: string
  focusMain(): void
  hideMain(): void
  quit(): void
  create(icon: string, menu: MenuItemConstructorOptions[]): TrayPort
}): Disposable {
  const menu = [
    { label: '显示主窗口', click: d.focusMain },
    { label: '隐藏主窗口', click: d.hideMain },
    { label: '退出', click: d.quit },
  ]
  const tray = d.create(d.icon, menu)
  tray.on('right-click', () => tray.popUpContextMenu())
  tray.on('click', d.focusMain)
  return { dispose: () => tray.destroy() }
}
