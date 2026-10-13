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

/*
 * R-04 §3.5：运行态 = 快照打底 + 之后的通知。
 *
 * 只靠 turns.state 通知的话：Core 在运行中崩溃重启之后最后一条通知停在 running，
 * 侧栏永远转圈、退出确认一直问（R-04 §1.4）；渲染进程重载后更是什么都不知道，
 * 正在跑的对话显示为空闲。修法是把 `threads.list` 的 `state` 喂回来打底，
 * 并用版本号保护「请求期间到达的通知」不被出发时的旧快照盖掉。
 */
describe('运行态快照打底与换代清零（R-04 §3.5）', () => {
  test('R-04 S7 通知比快照新：快照不覆盖它', () => {
    const store = createTurnStatesStore()
    const mark = store.mark()
    store.set({ threadId: 't1', state: 'running', error: null, startedAt: 1 })

    store.hydrate(
      [
        { id: 't1', state: 'idle' },
        { id: 't2', state: 'running' },
      ],
      mark,
    )

    /* t1 的通知在 mark 之后到过：出发时的旧快照（idle）不许盖回去。 */
    expect(store.get('t1')?.state).toBe('running')
    expect(store.isRunning('t1')).toBe(true)
    /* t2 没有通知，按快照说它正在跑。 */
    expect(store.isRunning('t2')).toBe(true)
  })

  test('R-04 S7b mark 之前的旧通知可以被快照更新（快照才是这一趟的真相）', () => {
    const store = createTurnStatesStore()
    store.set({ threadId: 't1', state: 'running', error: null, startedAt: 1 })
    const mark = store.mark()

    store.hydrate([{ id: 't1', state: 'idle' }], mark)

    expect(store.isRunning('t1')).toBe(false)
  })

  test('R-04 S7c 内容没变时不换引用（订阅者不白重画）', () => {
    const store = createTurnStatesStore()
    store.hydrate([{ id: 't1', state: 'idle' }], store.mark())
    const first = store.store.getState().byThread

    store.hydrate([{ id: 't1', state: 'idle' }], store.mark())

    expect(store.store.getState().byThread).toBe(first)
  })

  test('R-04 S8 resetAll 之后全部回到 idle、计数归零', () => {
    const store = createTurnStatesStore()
    store.set({ threadId: 't1', state: 'running', error: null, startedAt: 1 })
    store.set({ threadId: 't2', state: 'awaiting', error: null, startedAt: 2 })

    store.resetAll()

    expect(store.isRunning('t1')).toBe(false)
    expect(store.isRunning('t2')).toBe(false)
    expect(store.runningCount()).toBe(0)
  })

  /*
   * `version` 不归零：换代后发出的 mark 仍然大于换代前所有已发出的 mark，
   * 「重置之后到达的通知」与「重置之前取的 mark」因此不会撞号。
   */
  test('R-04 S8b resetAll 不把版本归零：换代后到达的通知仍比旧 mark 新', () => {
    const store = createTurnStatesStore()
    store.set({ threadId: 't1', state: 'running', error: null, startedAt: 1 })
    const before = store.mark()

    store.resetAll()
    const after = store.mark()

    expect(after).toBe(before)
    /* 换代后新 Core 推来一条通知：它仍然比换代前取的 mark 新，快照不覆盖它。 */
    store.set({ threadId: 't1', state: 'running', error: null, startedAt: 2 })
    store.hydrate([{ id: 't1', state: 'idle' }], before)
    expect(store.isRunning('t1')).toBe(true)
  })
})
