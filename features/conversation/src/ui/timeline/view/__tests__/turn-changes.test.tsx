import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { TurnChangesView } from '../../../../ui-api'
import { TurnChangesBar } from '../turn-changes'

/*
 * 回复下方那条改动的**读法**：几个人、加了删了多少、点撤销交出什么、办完是什么样子。
 *
 * 这一档钉的是文案与那两下交互；账本本身（哪一轮改了什么、撤销之后行数还是原值）由
 * review 的 core 测试钉，这里只按它交来的形状画。
 */

afterEach(cleanup)

function view(overrides: Partial<TurnChangesView> = {}): TurnChangesView {
  return {
    turn: 3,
    fileCount: 2,
    added: 12,
    removed: 5,
    reverted: false,
    files: [
      { path: 'features/review/src/ui/api.ts', added: 9, removed: 3 },
      { path: 'features/review/src/ui/index.tsx', added: 3, removed: 2 },
    ],
    ...overrides,
  }
}

/* 回调都注明返回 void：默认值是空函数，测试里换成 push 也不会改变推断出来的类型 */
function mount(overrides: Partial<TurnChangesView> = {}, expanded = false, onRewind: () => void = () => undefined) {
  return render(
    <TurnChangesBar expanded={expanded} onRewind={onRewind} onToggle={() => undefined} view={view(overrides)} />,
  )
}

describe('改动条的摘要', () => {
  test('N 个文件已更改，带各自的 +A -D', () => {
    const container = mount().container

    expect(container.querySelector('.turn-changes__summary')?.textContent).toBe('2 个文件已更改')
    expect(container.querySelector('.turn-changes__added')?.textContent).toBe('+12')
    expect(container.querySelector('.turn-changes__removed')?.textContent).toBe('-5')
  })

  test('只有一个文件时也是同一个量词（中文没有单复数）', () => {
    const container = mount({ fileCount: 1 }).container

    expect(container.querySelector('.turn-changes__summary')?.textContent).toBe('1 个文件已更改')
  })

  test('行数为 0 时照画 +0 -0：0 是事实，不是「还没读到」', () => {
    const container = mount({ added: 0, fileCount: 1, removed: 0 }).container

    expect(container.querySelector('.turn-changes__added')?.textContent).toBe('+0')
    expect(container.querySelector('.turn-changes__removed')?.textContent).toBe('-0')
  })
})

describe('改动条的展开', () => {
  test('收起时只列摘要，不铺文件清单', () => {
    const container = mount().container

    expect(container.querySelector('button.turn-changes__toggle')?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('.turn-changes__file')).toHaveLength(0)
  })

  test('展开后逐行列出文件名、目录与各自的增删', () => {
    const container = mount({}, true).container
    const rows = [...container.querySelectorAll('.turn-changes__file')]

    expect(container.querySelector('button.turn-changes__toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(rows).toHaveLength(2)
    /* 文件名与目录分开画：整格通读仍是那条路径，但文件名拿主墨、目录退一档。 */
    expect(rows[0]?.querySelector('.turn-changes__name')?.textContent).toBe('api.ts')
    expect(rows[0]?.querySelector('.turn-changes__dir')?.textContent).toBe('features/review/src/ui')
    expect(rows[0]?.querySelector('.turn-changes__added')?.textContent).toBe('+9')
    expect(rows[0]?.querySelector('.turn-changes__removed')?.textContent).toBe('-3')
  })

  test('根目录下的文件没有目录那一格：不画空的', () => {
    const container = mount({ files: [{ path: 'README.md', added: 1, removed: 0 }] }, true).container
    const row = container.querySelector('.turn-changes__file')

    expect(row?.querySelector('.turn-changes__name')?.textContent).toBe('README.md')
    expect(row?.querySelector('.turn-changes__dir')).toBeNull()
  })

  test('某一侧是 0 的文件行不画那个 0：没有增的行读「+0」只是噪音', () => {
    const container = mount({ files: [{ path: 'a.ts', added: 0, removed: 4 }] }, true).container
    const row = container.querySelector('.turn-changes__file')

    expect(row?.querySelector('.turn-changes__added')).toBeNull()
    expect(row?.querySelector('.turn-changes__removed')?.textContent).toBe('-4')
  })

  test('点摘要那一格把开合交出去（开关自己不管状态）', () => {
    const toggles: number[] = []
    const container = render(
      <TurnChangesBar expanded={false} onRewind={() => undefined} onToggle={() => toggles.push(1)} view={view()} />,
    ).container

    fireEvent.click(container.querySelector('button.turn-changes__toggle') as HTMLButtonElement)
    expect(toggles).toEqual([1])
  })
})

describe('改动条的撤销键', () => {
  test('点一下把这一轮交出去', () => {
    const rewinds: number[] = []
    const container = mount({}, false, () => rewinds.push(1)).container

    fireEvent.click(container.querySelector('button.turn-changes__rewind') as HTMLButtonElement)
    expect(rewinds).toEqual([1])
  })

  test('撤销还在路上时禁用：连点两次会把同一轮写回两遍', () => {
    const container = render(
      <TurnChangesBar busy expanded={false} onRewind={() => undefined} onToggle={() => undefined} view={view()} />,
    ).container
    const button = container.querySelector('button.turn-changes__rewind') as HTMLButtonElement

    expect(button.disabled).toBe(true)
  })

  test('已撤销：键还在（布局不跳），禁用且文案换成「已撤销」', () => {
    const container = mount({ reverted: true }).container
    const button = container.querySelector('button.turn-changes__rewind') as HTMLButtonElement

    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('已撤销')
    expect(container.querySelector('.turn-changes')?.getAttribute('data-reverted')).toBe('true')
  })

  test('撤销过的轮再点也交不出东西', () => {
    const rewinds: number[] = []
    const container = mount({ reverted: true }, false, () => rewinds.push(1)).container

    fireEvent.click(container.querySelector('button.turn-changes__rewind') as HTMLButtonElement)
    expect(rewinds).toEqual([])
  })

  test('可访问名说清撤的是哪一轮的多少个文件', () => {
    const container = mount().container

    expect(container.querySelector('button.turn-changes__rewind')?.getAttribute('aria-label')).toBe(
      '撤销这一轮的 2 个文件改动',
    )
  })
})
