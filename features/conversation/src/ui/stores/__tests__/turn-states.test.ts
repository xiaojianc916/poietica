import { describe, expect, test } from 'bun:test'
import { createTurnStatesStore } from '../turn-states'

/*
 * 真实故障：侧栏/输入框那一排订阅 turnStates 的组件一渲染就报
 * "Maximum update depth exceeded"。
 *
 * 根因在选择器那侧写的不是稳定引用：把 `new Set(...)` 放进选择器，每次渲染都交回一个
 * 新集合，`useShallow` 比的是集合引用，永远判成「变了」→ 无限重渲。
 *
 * 修法是把「集合」这一步挪到选择器**之外**（选 byThread 这个对象本身，再 useMemo 派生）。
 * 这条用例钉住那个前提：byThread 只在内容真的变了时才换引用 —— 没有它，上面那套修法
 * 只是碰巧成立。
 */
describe('turnStates 的 byThread 引用（订阅式选择器的前提）', () => {
  test('重复写入同一个状态时不换引用（同一份状态对象）', () => {
    const store = createTurnStatesStore()
    const state = { threadId: 't1', state: 'running', error: null, startedAt: 1 } as const

    store.set(state)
    const first = store.store.getState().byThread

    store.set(state)
    expect(store.store.getState().byThread).toBe(first)
  })

  test('写入另一条线程时换引用（新的那份才需要重画）', () => {
    const store = createTurnStatesStore()

    store.set({ threadId: 't1', state: 'running', error: null, startedAt: 1 })
    const first = store.store.getState().byThread

    store.set({ threadId: 't2', state: 'running', error: null, startedAt: 2 })
    expect(store.store.getState().byThread).not.toBe(first)
  })

  test('读的是同一份状态时引用不变（setState 交回原值即不通知）', () => {
    const store = createTurnStatesStore()
    const state = { threadId: 't1', state: 'idle', error: null, startedAt: null } as const

    store.set(state)
    const before = store.store.getState()

    /* 同一条线程、同一个对象：zustand 自己会判等并跳过通知 */
    store.set(state)
    expect(store.store.getState()).toBe(before)
  })
})
