import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { Dialog } from '../control/dialog'

/* 对话框表头的操作：和关闭钮同一行，排在它前面；不给就只有关闭钮（结构不变） */

afterEach(() => {
  cleanup()
})

test('DA1 actions 画在表头、关闭钮之前；不给 actions 时表头只有标题与关闭钮', async () => {
  await act(async () => {
    render(
      <Dialog
        actions={
          <button aria-label="展开" type="button">
            +
          </button>
        }
        onOpenChange={() => undefined}
        open
        title="界面"
      >
        <p>正文</p>
      </Dialog>,
    )
  })
  const header = document.querySelector('header')
  expect(header).not.toBeNull()
  const labels = [...(header?.querySelectorAll('button') ?? [])].map((button) => button.getAttribute('aria-label'))
  expect(labels).toEqual(['展开', '关闭'])
  cleanup()

  await act(async () => {
    render(
      <Dialog onOpenChange={() => undefined} open title="界面">
        <p>正文</p>
      </Dialog>,
    )
  })
  const plain = document.querySelector('header')
  expect([...(plain?.querySelectorAll('button') ?? [])].map((button) => button.getAttribute('aria-label'))).toEqual([
    '关闭',
  ])
})
