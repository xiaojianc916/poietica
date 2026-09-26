/*
 * 中止信号的两种到达时刻。
 *
 * `AbortSignal` 的监听器只在 abort **之后**触发：信号如果在我们登记之前就已经中止，
 * 监听器永远不响。少这一格，一个已经作废的对话框会永远留在等人答的表里 ——
 * 屏幕上是收不掉的带子，agent 那头也没有人在等。
 *
 * 自检跑法：bun test src/__tests__/dialog-abort.test.ts
 */

import { expect, test } from 'bun:test'
import { DialogDesk } from '../approval.ts'

function deskWithRecorder(): {
  desk: DialogDesk
  asked: { id: string }[]
  closed: { id: string | undefined; kind: string }[]
} {
  const asked: { id: string }[] = []
  const closed: { id: string | undefined; kind: string }[] = []

  const desk = new DialogDesk(
    (frame) => {
      asked.push({ id: String(frame['id']) })
    },
    (event) => {
      if (event.kind === 'timeout' || event.kind === 'aborted') {
        closed.push({ id: event.id, kind: event.kind })
      }
    },
  )

  return { desk, asked, closed }
}

test('a signal that aborts later closes the dialog', async () => {
  const { desk, closed } = deskWithRecorder()
  const controller = new AbortController()

  const pending = desk.ask(
    { method: 'select', title: 'Allow tool: bash' },
    {
      signal: controller.signal,
    },
  )

  controller.abort()

  expect(await pending).toMatchObject({ cancelled: true })
  expect(closed).toEqual([{ id: 'd1', kind: 'aborted' }])
})

test('a signal that has ALREADY aborted still closes the dialog instead of hanging it', async () => {
  const { desk, closed } = deskWithRecorder()
  const controller = new AbortController()

  // 一个在登记之前就已经作废的信号：监听器不会有第二次机会响。
  controller.abort()

  const pending = desk.ask(
    { method: 'select', title: 'Allow tool: bash' },
    {
      signal: controller.signal,
    },
  )

  expect(await pending).toMatchObject({ cancelled: true })
  expect(closed).toEqual([{ id: 'd1', kind: 'aborted' }])
})

test('an already-aborted signal does not even surface a dialog', async () => {
  const { desk, asked } = deskWithRecorder()
  const controller = new AbortController()
  controller.abort()

  await desk.ask({ method: 'select', title: 'Allow tool: bash' }, { signal: controller.signal })

  /*
   * 已经作废的那一次不该挂在人面前：没人能答它，屏幕上的带子只会永远收不掉。
   * 这一条钉的是「先看信号再登记」那个次序。
   */
  expect(asked).toEqual([])
})
