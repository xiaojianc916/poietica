/*
 * 取消一轮时，屏幕上那些「在等人答」的必须一起收掉。
 *
 * 缘起是一个真实的挂相：上游授权闸门问的那一次 `select` **不带 signal**
 * （extensibility/extensions/wrapper.ts:333 的 `uiContext.select(safetyPrompt, ["Approve","Deny"])`），
 * 所以点「取消」并不会让那一次对话框自己作罢。桥若只管把轮终报出去，
 * 屏幕上那条带子会永远停在「等你批」——而这一轮早就取消了，没有人再等这个答案。
 *
 * 自检跑法：bun test src/__tests__/cancel-drains-dialogs.test.ts
 */

import { expect, test } from 'bun:test'
import { applyOperation, EMPTY_AGENT_STATE } from '@poietica/transcript'
import { DialogDesk } from '../approval.ts'
import { interactionOp } from '../projection.ts'

/** 把审批开成 pending 再按取消收掉，交出收完之后的 interactions。 */
function afterCancel(): { id: string; state: string }[] {
  const ops = [
    ...interactionOp({
      interactionId: 'd1',
      kind: 'approval',
      state: 'pending',
      toolCallId: 'bash',
    }),
    // 取消那一趟收的方式：同一号、状态 cancelled。
    ...interactionOp({
      interactionId: 'd1',
      kind: 'approval',
      state: 'cancelled',
      toolCallId: 'bash',
    }),
  ]

  let state = EMPTY_AGENT_STATE
  for (const op of ops) {
    state = applyOperation(state, op).state
  }

  return [...state.interactions.values()].map((held) => ({
    id: held.interactionId,
    state: held.state,
  }))
}

test('a cancelled round closes the approval it was waiting on', () => {
  // 取消之后那一条不再是 pending：带子的挂载条件因此不再成立。
  expect(afterCancel()).toEqual([{ id: 'd1', state: 'cancelled' }])
})

test('closing every waiting dialog resolves the promises the agent is blocked on', async () => {
  const desk = new DialogDesk(() => {})

  // 三次问话都挂着（授权闸门那条路就是没有 signal 的那一种）。
  const first = desk.ask({ method: 'select', title: 'Allow tool: bash' })
  const second = desk.ask({ method: 'ask', questions: [] })
  const third = desk.ask({ method: 'confirm', title: 'sure?' })

  const closed = desk.closeAll()

  /*
   * 三个都要结：留着任何一个，上游那次工具调用就永远停在 await 上 ——
   * 这一轮已经取消了，没有人再会来答它。
   */
  expect(closed).toBe(3)
  expect(await first).toMatchObject({ cancelled: true })
  expect(await second).toMatchObject({ cancelled: true })
  expect(await third).toMatchObject({ cancelled: true })
})

test('closing is idempotent and does not disturb a dialog that already settled', async () => {
  const desk = new DialogDesk(() => {})

  const settled = desk.ask({ method: 'select', title: 'Allow tool: read' })
  desk.settle('d1', { value: 'Approve' })

  expect(await settled).toMatchObject({ value: 'Approve' })
  // 已经答过的那一个不该被再结一次，也不该被算进「还有几个在等」。
  expect(desk.closeAll()).toBe(0)
})
