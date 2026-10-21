import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, render } from '@testing-library/react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../control/dropdown-menu'

/*
 * 菜单族的表面契约（照 zcode 的 DropdownMenu）。
 *
 * 菜单和弹窗是两种材质：弹窗圆角 16、可以透；菜单是贴着一个控件展开的实色卡 —— 圆角 8、1px 收边、
 * 行 28 高。这些值一旦漏改，屏幕上就是「菜单不像菜单」，而单看代码又都说得通。
 */

const tokensDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tokens')

afterEach(() => {
  cleanup()
})

const menu = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('.ds-menu-card')
  if (element === null) throw new Error('菜单卡没渲染出来')
  return element
}

const renderMenu = async (): Promise<void> => {
  await act(async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>更多</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>一行</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>两行</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
  })
}

describe('菜单族的表面', () => {
  test('三支颜色令牌就是 zcode 的真值', () => {
    /*
     * 底 = zcode --color-menu、悬停 = --color-menu-hover、线 = --color-border。深色那支
     * rgba(255,255,255,.1) 压在 #2b2b2b 上兑出来正是 #414141，所以 #414141 从来不是第四支令牌。
     *
     * 读源文件而不是 getComputedStyle：单测的 happy-dom 不跑 @import 的样式表，变量取不到。
     */
    const read = (name: string) => readFileSync(join(tokensDir, name), 'utf8')
    const declOf = (css: string, token: string): string => {
      const found = new RegExp(`${token}:[^;]+;`).exec(css)?.[0]
      if (found === undefined) throw new Error(`源文件里找不到 ${token}`)

      /* found 形如 --ui-menu: #2b2b2b; ：去掉令牌名、冒号与分号。 */
      return found.slice(token.length + 1, -1).trim()
    }

    const dark = read('dark.css')
    expect(declOf(dark, '--ui-menu')).toBe('#2b2b2b')
    expect(declOf(dark, '--ui-menu-hover')).toBe('#363636')
    /* zcode 写的是 rgba(255,255,255,.1)，浏览器兑在 #2b2b2b 上的结果就是 #414141；这里存兑好后的实色。 */
    expect(declOf(dark, '--ui-menu-border')).toBe('#414141')

    const light = read('light.css')
    expect(declOf(light, '--ui-menu')).toBe('#ffffff')
    expect(declOf(light, '--ui-menu-hover')).toBe('#f0f0f0')
    expect(declOf(light, '--ui-menu-border')).toBe('#e6e6e6')
  })

  test('卡：圆角 8、1px 描边、实色底、shadow-md、内边距 4、行间 2', async () => {
    await renderMenu()

    const classes = [...menu().classList]
    expect(classes).toContain('rounded-md')
    expect(classes).toContain('border')
    expect(classes).toContain('bg-menu')
    expect(classes).toContain('shadow-md')
    expect(classes).toContain('p-1')
    expect(classes).toContain('gap-0.5')
    /* 玻璃底是弹窗那一层的事，菜单不透明。 */
    expect(classes.some((name) => name.includes('backdrop-filter'))).toBe(false)
  })

  test('行：最小 28 高、圆角 6、内边距 4/8、字 14/1.625、间距 8', async () => {
    await renderMenu()

    const item = menu().querySelector<HTMLElement>('[role="menuitem"]')
    const classes = [...(item?.classList ?? [])]
    expect(classes).toContain('min-h-7')
    expect(classes).toContain('rounded-sm')
    expect(classes).toContain('px-2')
    expect(classes).toContain('py-1')
    expect(classes).toContain('gap-2')
    expect(classes).toContain('text-sm')
    expect(classes).toContain('leading-relaxed')
  })

  test('分隔线横贯整卡，不再只缩在行宽里', async () => {
    await renderMenu()

    const separator = menu().querySelector('.ds-menu-separator')
    expect([...(separator?.classList ?? [])]).toEqual(expect.arrayContaining(['-mx-1', 'my-1', 'h-[0.5px]']))
  })
})
