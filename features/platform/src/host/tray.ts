import type { Disposable } from '@poietica/foundation'
import type { Menu, MenuItemConstructorOptions, Tray } from 'electron'

/** 只持有原生托盘与菜单：Windows 自己分发右键，不能再用 right-click 手动弹一次。 */
export function createTray(d: {
  focusMain(): void
  hideMain(): void
  quit(): void
  buildMenu(items: MenuItemConstructorOptions[]): Menu
  tray: Pick<Tray, 'destroy' | 'setContextMenu'> & { on(event: 'click', listener: () => void): unknown }
}): Disposable {
  const menu = d.buildMenu([
    { label: '显示主窗口', click: d.focusMain },
    { label: '隐藏主窗口', click: d.hideMain },
    { label: '退出', click: d.quit },
  ])
  d.tray.setContextMenu(menu)
  d.tray.on('click', d.focusMain)
  return { dispose: () => d.tray.destroy() }
}
