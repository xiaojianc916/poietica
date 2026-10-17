import { expect, test } from 'bun:test'
import {
  createTimelineState,
  type TimelineItem,
  type TimelineState,
  type ToolCallTimelineItem,
  type TurnPage,
} from '../../shared/timeline/timeline-contract'
import { clientTurnIdsOf, delegateCallsOf } from '../timeline-queries'

/*
 * 每批 / 每帧都要问的几条时间线查询，已封口的页只扫一次。
 *
 * 「只扫一次」用读 `items` 的次数量：已封口页的 `items` 换成计数的 getter。
 * 旧实现每问一次就把全部页从头扫一遍，计数随调用次数线性增长。
 */

function countedPage(turn: number, items: readonly TimelineItem[]): { page: TurnPage; reads: () => number } {
  let reads = 0
  const page = {
    turn,
    get items() {
      reads += 1
      return items
    },
  } as TurnPage
  return { page, reads: () => reads }
}

const userMessage = (turn: number, clientTurnId?: string): TimelineItem =>
  ({
    type: 'user_message',
    id: `u${String(turn)}`,
    turn,
    at: 0,
    text: `问 ${String(turn)}`,
    ...(clientTurnId === undefined ? {} : { clientTurnId }),
  }) as TimelineItem

const delegateCall = (turn: number, id: string, status: ToolCallTimelineItem['status']): TimelineItem =>
  ({
    type: 'tool_call',
    id,
    turn,
    at: 0,
    toolCallId: id,
    title: `派 ${id}`,
    kind: 'delegate',
    status,
    requestContent: [],
    content: [],
    locations: [],
  }) as unknown as TimelineItem

function stateOf(sealed: readonly TurnPage[], active: TurnPage, status: TimelineState['status'] = 'idle') {
  return { ...createTimelineState(), status, sealed, active }
}

test('Q3 clientTurnIdsOf：收齐封口页与在跑页的提交号，封口页只读一次', () => {
  const pages = [countedPage(1, [userMessage(1, 'c1')]), countedPage(2, [userMessage(2)])]
  const sealed = pages.map((entry) => entry.page)
  clientTurnIdsOf(stateOf(sealed, { turn: 3, items: [] }))
  const ids = clientTurnIdsOf(stateOf(sealed, { turn: 3, items: [userMessage(3, 'c3')] }))

  expect([...ids].sort()).toEqual(['c1', 'c3'])
  expect(pages.map((entry) => entry.reads())).toEqual([1, 1])
})

test('Q4 delegateCallsOf：结清的计数、在跑的按顺序交回，封口页只读一次', () => {
  const first = countedPage(1, [delegateCall(1, 'a', 'completed'), delegateCall(1, 'b', 'in_progress')])
  const active = { turn: 2, items: [delegateCall(2, 'c', 'pending'), delegateCall(2, 'd', 'failed')] }
  delegateCallsOf(stateOf([first.page], active))
  const calls = delegateCallsOf(stateOf([first.page], active))

  expect(calls.ended).toBe(2)
  expect(calls.finished.map((call) => call.toolCallId)).toEqual(['a', 'd'])
  expect(calls.running.map((call) => call.toolCallId)).toEqual(['b', 'c'])
  expect(first.reads()).toBe(1)
})
