import { expect, test } from 'bun:test'
import {
  createTimelineState,
  type TimelineItem,
  type TimelineState,
  type TodoItem,
  type ToolCallTimelineItem,
  type TurnPage,
} from '../../shared/timeline/timeline-contract'
import { currentTodos } from '../timeline-queries'

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

const todoCall = (turn: number, status: ToolCallTimelineItem['status'], titles: readonly string[]): TimelineItem =>
  ({
    type: 'tool_call',
    id: `todo${String(turn)}${status}`,
    turn,
    at: 0,
    toolCallId: `todo${String(turn)}`,
    title: 'todo',
    kind: 'todo',
    status,
    requestContent: [
      {
        type: 'todo',
        items: titles.map((title): TodoItem => ({ title, status: 'pending' })),
      },
    ],
    content: [],
    locations: [],
  }) as unknown as TimelineItem

function stateOf(sealed: readonly TurnPage[], active: TurnPage, status: TimelineState['status'] = 'idle') {
  return { ...createTimelineState(), status, sealed, active }
}

test('Q1 currentTodos：问两次，已封口页的 items 只读一次', () => {
  const pages = [1, 2, 3].map((turn) => countedPage(turn, [userMessage(turn)]))
  const sealed = pages.map((entry) => entry.page)
  currentTodos(stateOf(sealed, { turn: 4, items: [userMessage(4)] }, 'running'))
  currentTodos(stateOf(sealed, { turn: 4, items: [userMessage(4), userMessage(4)] }, 'running'))

  expect(pages.map((entry) => entry.reads())).toEqual([1, 1, 1])
})

test('Q2 currentTodos：判据不变 —— 在跑那一轮的未完成清单算实时预览，封口页里的未完成不算', () => {
  const settled = { turn: 1, items: [todoCall(1, 'completed', ['旧'])] }
  const stale = { turn: 2, items: [todoCall(2, 'in_progress', ['半截'])] }
  const live = { turn: 3, items: [todoCall(3, 'in_progress', ['实时'])] }

  expect(currentTodos(stateOf([settled, stale], live, 'running'))?.map((item) => item.title)).toEqual(['实时'])
  expect(currentTodos(stateOf([settled, stale], live, 'idle'))?.map((item) => item.title)).toEqual(['旧'])
  expect(currentTodos(stateOf([], { turn: 0, items: [] }))).toBeNull()
})
