/*
 * 对话框的生命周期：每一种开门都必须有一条关门的路。
 *
 * 起因是一个真实的挂死隐患：一道读不出来的题组若不回话，`askDialog` 的 Promise
 * 永远挂着，人没有可答的东西，模型就永远等下去 —— 症状是「这一轮没反应」，
 * 而日志里一个字都没有。所以判据不是「画不画得出来」，而是「有没有人收尾」。
 *
 * 自检跑法：bun test src/__tests__/dialog-lifecycle.test.ts
 */

import { expect, test } from 'bun:test'
import { DialogDesk } from '../approval.ts'

/** 一张只记账的桌：把每次问话记下来，好让测试按同样的号答复。 */
function deskWithRecorder(): {
  desk: DialogDesk
  asked: { id: string; frame: Record<string, unknown> }[]
  settled: { id: string; payload: Record<string, unknown> }[]
  /** 没人答而收场的（超时/中止）：屏幕靠它把带子收掉。 */
  closed: { id: string | undefined; kind: string }[]
} {
  const asked: { id: string; frame: Record<string, unknown> }[] = []
  const settled: { id: string; payload: Record<string, unknown> }[] = []
  const closed: { id: string | undefined; kind: string }[] = []

  const desk = new DialogDesk(
    (frame) => {
      asked.push({ id: String(frame['id']), frame })
    },
    (event) => {
      if (event.kind === 'settled') {
        settled.push({ id: event.id, payload: event.payload })

        return
      }

      if (event.kind === 'timeout' || event.kind === 'aborted') {
        closed.push({ id: event.id, kind: event.kind })
      }
    },
  )

  return { desk, asked, settled, closed }
}

test('a dialog that nobody answers stays open — that is why every open needs a close', async () => {
  const { desk, asked } = deskWithRecorder()

  // 不 await：这一条问出去之后没人答，它就该一直挂着。
  const pending = desk.ask({ method: 'select', title: 'Allow tool: bash' })

  expect(asked).toHaveLength(1)

  // 用一个已经落定的答复证明它此前确实没结（同一条 promise 只能结一次）。
  desk.settle(asked[0]?.id ?? '', { value: 'Approve' })

  expect(await pending).toMatchObject({ value: 'Approve' })
})

test('cancelling an unreadable dialog closes the round instead of hanging it', async () => {
  const { desk, asked } = deskWithRecorder()

  const pending = desk.ask({ method: 'ask', questions: [] })

  /*
   * 这就是 main.ts 的 openQuestion 在「一道题都认不出」时做的事：
   * 如实收成取消，而不是留一个没人能答的对话框。上游把空结果读成「用户取消」
   * （tools/ask.ts:946-949），那一轮因此停在一个说得清的地方。
   */
  desk.settle(asked[0]?.id ?? '', { cancelled: true })

  expect(await pending).toMatchObject({ cancelled: true })
})

test('settling an unknown id says so rather than pretending to answer', () => {
  const { desk } = deskWithRecorder()

  // 假答等于让人以为答复送到了，而 agent 那头永远等不到。
  expect(() => {
    desk.settle('nobody-is-waiting', { value: 'Approve' })
  }).toThrow('no dialog is waiting under nobody-is-waiting')
})

test('a timeout closes the dialog and tells the screen why', async () => {
  const { desk, asked, closed } = deskWithRecorder()

  const pending = desk.ask({ method: 'select', title: 'Allow tool: bash' }, { timeout: 5 })

  expect(await pending).toMatchObject({ cancelled: true })

  /*
   * 超时是**没人答**，不是一次答复：报的是 timeout 而不是 settled。
   * 屏幕据它把那条带子收掉 —— 只结 Promise 而不告知，带子会永远停在那里，
   * 而它背后的对话框早就作废了。
   */
  expect(closed).toEqual([{ id: asked[0]?.id, kind: 'timeout' }])
})
