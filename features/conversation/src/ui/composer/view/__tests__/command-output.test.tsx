import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CommandOutputDock, looksTabular } from '../command-output'

/*
 * U-04：命令结果。一句话的结果一行说完（命令名 · 结果 · 关闭）；多行的才是一张卡、可复制。
 * 正文默认正文字体，按列对齐的报表才换等宽。没有「跑着」那一态：一出现就是结果。
 */
afterEach(cleanup)

describe('命令结果', () => {
  test('一句话：一行，名字 + 结果 + 关闭，没有转圈', () => {
    let dismissed = 0
    const { container, getByLabelText } = render(
      <CommandOutputDock
        command="/shake"
        lines={['已移除 3 个工具结果，释放约 12.3K token']}
        onDismiss={() => {
          dismissed += 1
        }}
      />,
    )
    const dock = container.querySelector('.assistant-command-output')
    expect(dock?.getAttribute('data-shape')).toBe('line')
    expect(dock?.querySelector('.assistant-command-output__name')?.textContent).toBe('/shake')
    expect(dock?.querySelector('.assistant-command-output__line')?.textContent).toBe(
      '已移除 3 个工具结果，释放约 12.3K token',
    )
    expect(container.querySelector('.assistant-command-output__body')).toBeNull()
    fireEvent.click(getByLabelText('关闭'))
    expect(dismissed).toBe(1)
  })

  test('多行：一张卡，标题只是命令名（不带参数），可复制；报表换等宽', () => {
    const { container, getByLabelText } = render(
      <CommandOutputDock
        command="/context full"
        lines={['Context window: 200000 tokens (20% used)', '  Messages         ███░░  40000 tokens']}
        onDismiss={() => undefined}
      />,
    )
    const dock = container.querySelector('.assistant-command-output')
    expect(dock?.getAttribute('data-shape')).toBe('block')
    expect(dock?.querySelector('.assistant-command-output__name')?.textContent).toBe('/context')
    expect(container.querySelector('.assistant-command-output__body')?.getAttribute('data-tabular')).toBe('true')
    expect(getByLabelText('复制结果')).toBeDefined()
  })

  test('报表的判据：用量条、两格以上空白对齐、行首缩进；普通的几句话不是', () => {
    expect(looksTabular('Free   ░░░░  1000')).toBe(true)
    expect(looksTabular('第一行\n  缩进的一行')).toBe(true)
    expect(looksTabular('已导出到 C:/a.html\n可以在浏览器里打开。')).toBe(false)
  })
})
