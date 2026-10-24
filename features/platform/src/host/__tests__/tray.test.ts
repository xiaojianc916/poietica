import { describe, expect, mock, test } from 'bun:test'
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
    const setContextMenu = mock((_menu: Menu) => {})
    const disposable = createTray({
      buildMenu: (menuItems) => {
        items = menuItems
        menuCalls.push(`menu:${items.map((item) => item.label).join(',')}`)
        return {} as Menu
      },
      tray: {
        setContextMenu,
        on(event, listener) {
          events.set(event, listener)
          return this
        },
        destroy() {
          destroyed = true
        },
      },
      focusMain: () => {
        visible = true
      },
      hideMain: () => {
        visible = false
      },
      quit: () => {
        menuCalls.push('quit')
      },
    })
    click(0)
    click(2)
    click(1)
    menuCalls.push(`hidden:${!visible}`)
    events.get('click')?.()
    menuCalls.push(`visible:${visible}`)
    disposable.dispose()

    expect(setContextMenu).toHaveBeenCalledTimes(1)
    expect(events.has('right-click')).toBe(false)
    expect(menuCalls).toEqual(['menu:显示主窗口,隐藏主窗口,退出', 'quit', 'hidden:true', 'visible:true'])
    expect(visible).toBe(true)
    expect(destroyed).toBe(true)
  })
})
