import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkspacePicker } from '../control/workspace-picker'

/*
 * 用户裁决（2026-10-20）：删掉「临时会话 / 不在项目中工作」这一整条概念 ——
 * 项目选择器里不再有那个入口，菜单只剩「项目名单 + 新建项目」。
 */

afterEach(() => {
  cleanup()
})

const CHOICES = [
  { id: 'w1', name: 'poietica' },
  { id: 'w2', name: 'scripts' },
]

async function openMenu(current: { id: string; name: string } | null): Promise<HTMLElement> {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <WorkspacePicker
        choices={CHOICES}
        current={current}
        onBrowse={() => undefined}
        onChoose={() => undefined}
        placement="composer"
      />,
    )
  })

  const trigger = screen.getByRole('button', { name: '切换项目' })
  await act(async () => {
    fireEvent.click(trigger)
  })

  return view.container
}

describe('WorkspacePicker：项目必选', () => {
  test('还没选项目时胶囊写「选择项目」；菜单里只有项目与「新建项目」，没有「不在项目中工作」', async () => {
    await openMenu(null)

    expect(screen.getByRole('button', { name: '切换项目' }).textContent).toContain('选择项目')
    expect(document.body.textContent ?? '').toContain('新建项目')
    expect(document.body.textContent ?? '').not.toContain('不在项目中工作')
  })

  test('选中项目后胶囊写项目名；菜单里没有清除/脱离项目的入口', async () => {
    await openMenu({ id: 'w1', name: 'poietica' })

    expect(screen.getByRole('button', { name: '切换项目' }).textContent).toContain('poietica')
    expect(document.body.textContent ?? '').not.toContain('不在项目中工作')
    /* 没有那一格清除键：整张菜单只有名单里的两行 + 新建一行。 */
    expect(document.querySelectorAll('.workspace-picker__item').length).toBe(3)
  })
})
