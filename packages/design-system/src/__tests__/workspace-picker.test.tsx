import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkspacePicker } from '../control/workspace-picker'

/*
 * 入口页与自动化编辑器共用这一个选择器：没选项目时胶囊写「选择项目」，选了写项目名；
 * 菜单里既有项目名单，也有「新建项目」这个出口。
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
  test('还没选项目时胶囊写「选择项目」，菜单给得出「新建项目」', async () => {
    await openMenu(null)

    expect(screen.getByRole('button', { name: '切换项目' }).textContent).toContain('选择项目')
    expect(document.body.textContent ?? '').toContain('新建项目')
  })

  test('选中项目后胶囊写项目名', async () => {
    await openMenu({ id: 'w1', name: 'poietica' })

    expect(screen.getByRole('button', { name: '切换项目' }).textContent).toContain('poietica')
  })
})
