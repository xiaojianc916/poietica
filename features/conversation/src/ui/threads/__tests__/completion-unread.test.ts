import { describe, expect, test } from 'bun:test'
import { createCompletionUnreadStore } from '../completion-unread'

/*
 * 绿点（DSH 的 completionUnread）：只在 running / awaiting → idle 的**边沿**点亮，并且只对
 * 「不是当前正看着的那条」点亮。首帧快照里的 idle 不算完成 —— 否则一开机满列绿点。
 */
function ids(store: ReturnType<typeof createCompletionUnreadStore>): readonly string[] {
  return [...store.store.getState().ids]
}

describe('完成未看（绿点）', () => {
  test('跑完回到 idle，且不是当前这条：点亮', () => {
    const store = createCompletionUnreadStore()
    store.observe('t1', 'running', 'idle', 't2')
    expect(ids(store)).toEqual(['t1'])
  })

  test('停在等审批上之后收口：同样算跑完', () => {
    const store = createCompletionUnreadStore()
    store.observe('t1', 'awaiting', 'idle', null)
    expect(ids(store)).toEqual(['t1'])
  })

  test('当前正看着的那条跑完不点亮：人就在那儿看着', () => {
    const store = createCompletionUnreadStore()
    store.observe('t1', 'running', 'idle', 't1')
    expect(ids(store)).toEqual([])
  })

  test('首帧快照里的 idle 不是一次完成', () => {
    const store = createCompletionUnreadStore()
    store.observe('t1', undefined, 'idle', null)
    expect(ids(store)).toEqual([])
  })

  test('重新开跑：上一次的提醒作废', () => {
    const store = createCompletionUnreadStore()
    store.observe('t1', 'running', 'idle', null)
    store.observe('t1', 'idle', 'running', null)
    expect(ids(store)).toEqual([])
  })

  test('打开这条（或线程被删）即收掉：重复调用无副作用', () => {
    const store = createCompletionUnreadStore()
    store.observe('t1', 'running', 'idle', null)
    const before = store.store.getState().ids

    store.consume('t1')
    store.consume('t1')
    expect(ids(store)).toEqual([])

    store.observe('t2', 'running', 'idle', null)
    store.clear('t2')
    expect(ids(store)).toEqual([])
    /* 已经收掉之后再 consume，不该换引用（订阅者不白重画）。 */
    const settled = store.store.getState().ids
    store.consume('t1')
    expect(store.store.getState().ids).toBe(settled)
    expect(before).not.toBe(settled)
  })
})
