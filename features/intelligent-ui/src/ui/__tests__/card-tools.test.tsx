import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { FrameTools } from '../card'

/*
 * 工具条：时间线里那一份在界面下面一行（不再浮在界面上，盖不住界面自己的按钮），展开后那一份进对话框表头。
 * 提示走 design-system 的 Tooltip，不留 title（Electron 在 Windows 上画的是系统那种白边小框）。
 */

afterEach(() => {
  cleanup()
})

const noop = (): void => undefined

async function toolbar(placement: 'row' | 'header', onExpand?: () => void): Promise<HTMLElement> {
  await act(async () => {
    render(
      <FrameTools
        capturing={false}
        onCopy={noop}
        onExpand={onExpand}
        onExport={noop}
        onTweak={noop}
        placement={placement}
        tweaking
      />,
    )
  })
  const found = document.querySelector<HTMLElement>('[role="toolbar"]')
  if (found === null) throw new Error('没有工具条')
  return found
}

test('CT1 两处的按钮都没有 title；调整钮带按下态', async () => {
  const row = await toolbar('row', noop)
  expect(row.dataset.placement).toBe('row')
  const buttons = [...row.querySelectorAll('button')]
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
    '调整',
    '复制为图片',
    '导出 HTML',
    '展开',
  ])
  expect(buttons.every((button) => !button.hasAttribute('title'))).toBe(true)
  expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
})

test('CT2 表头那一份没有「展开」；展开模式没有「展开」', async () => {
  const header = await toolbar('header')
  expect(header.dataset.placement).toBe('header')
  const buttons = [...header.querySelectorAll('button')]
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['调整', '复制为图片', '导出 HTML'])
  expect(buttons.every((button) => !button.hasAttribute('title'))).toBe(true)
})
