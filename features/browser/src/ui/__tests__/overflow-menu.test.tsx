import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserOverflowMenu } from '../overflow-menu'

/*
 * 「更多操作」菜单里的死按钮（B-15）。legacy 那张行清单照搬过来时，查找、设备工具栏、
 * 导入 Cookie、密码、下载、历史、清除浏览数据、浏览器设置都还没有命令面，却都画成了
 * 可点 —— 点下去什么都不发生。
 *
 * 判据改成「有没有处理函数」：`commands` 里给了才可点，没给的一律画成灰行。
 */

/*
 * 菜单一挂上就摆位（Base UI 的 MenuPositioner 会自己再渲染一次），所以挂载要走
 * act 的异步那一路，否则那一次更新落在 act 之外。
 */
async function mount(commands: Readonly<Partial<Record<string, () => void>>> = {}): Promise<void> {
  await act(async () => {
    render(
      <BrowserOverflowMenu
        commands={commands}
        onHeightChange={() => undefined}
        onOpenChange={() => undefined}
        onReopen={() => undefined}
        onZoom={() => undefined}
        open
        recentlyClosed={[]}
        zoomLevel={0}
      />,
    )
  })
}

/** 菜单行按文案取；没有命令面的那些行是 Base UI 的 disabled 项。 */
function row(label: string): HTMLElement {
  const found = screen.getByText(label).closest('[role="menuitem"]')

  if (!(found instanceof HTMLElement)) {
    throw new Error(`菜单里没有这一行：${label}`)
  }

  return found
}

const isDisabled = (element: HTMLElement): boolean =>
  element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('data-disabled')

afterEach(() => {
  cleanup()
})

describe('溢出菜单：没有命令面的条目画成灰行（B-15）', () => {
  test('一个命令都没给时，那些行全部不可点', async () => {
    await mount()

    for (const label of [
      '在页面中查找',
      '显示设备工具栏',
      '导入 Cookie 和密码…',
      '密码和自动填充',
      '下载',
      '历史记录',
      '清除浏览数据',
      '浏览器设置',
    ]) {
      expect(isDisabled(row(label))).toBe(true)
    }
  })

  test('给了处理函数的那一行可点，点一下就调用它', async () => {
    let called = 0

    await mount({
      'find-in-page': () => {
        called += 1
      },
    })

    const find = row('在页面中查找')

    expect(isDisabled(find)).toBe(false)

    fireEvent.click(find)

    expect(called).toBe(1)

    /* 没给处理函数的邻居照旧灰着。 */
    expect(isDisabled(row('下载'))).toBe(true)
  })

  test('缩放与最近关闭这两栏不受影响', async () => {
    await mount({ 'find-in-page': () => undefined })

    expect(screen.getByText('缩放')).toBeDefined()
    expect(screen.getByText('没有最近关闭的标签页')).toBeDefined()
  })
})
