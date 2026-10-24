import { describe, expect, test } from 'bun:test'
import type { Menu, MenuItemConstructorOptions } from 'electron'
import { createTray } from '../tray'

describe('tray', () => {
  test('用应用图标创建托盘，右键菜单控制窗口和退出，点击图标显示主窗口', () => {
    const events = new Map<string, () => void>()
    const menuCalls: string[] = []
    let items: MenuItemConstructorOptions[] = []
    const click = (index: number): void => {
      const handler = items[index]?.click
      if (typeof handler === 'function') (handler as () => void)()
    }
    let destroyed = false
    let visible = false
    const disposable = createTray({
      icon: 'C:/resources/icon.ico',
      focusMain: () => {
        visible = true
      },
      hideMain: () => {
        visible = false
      },
      quit: () => {
        menuCalls.push('quit')
      },
      create: (icon, menuItems) => {
        items = menuItems
        menuCalls.push(`icon:${icon}`, `menu:${items.map((item) => item.label).join(',')}`)
        click(0)
        click(2)
        click(1)
        menuCalls.push(`hidden:${!visible}`)
        return {
          setContextMenu() {},
          popUpContextMenu(menu?: Menu) {
            menuCalls.push(`popup:${menu === undefined}`)
          },
          on(event, listener) {
            events.set(event, listener)
            return this
          },
          destroy() {
            destroyed = true
          },
        }
      },
    })
    events.get('click')?.()
    events.get('right-click')?.()
    menuCalls.push(`visible:${visible}`)
    disposable.dispose()

    expect(menuCalls).toEqual([
      'icon:C:/resources/icon.ico',
      'menu:显示主窗口,隐藏主窗口,退出',
      'quit',
      'hidden:true',
      'popup:true',
      'visible:true',
    ])
    expect(visible).toBe(true)
    expect(destroyed).toBe(true)
  })
})
