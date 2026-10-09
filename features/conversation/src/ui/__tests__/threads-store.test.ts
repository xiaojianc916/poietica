import { describe, expect, test } from 'bun:test'
import type { Thread } from '../../contract'
import type { ConversationApi } from '../api'
import { createThreadsStore } from '../stores/threads'
import { createTurnStatesStore } from '../stores/turn-states'

/*
 * R-04 S9：`threads.list` 的 `state` 是运行态的**快照兜底**。
 *
 * 只信 turns.state 通知的话：Core 在运行中崩溃重启，最后一条通知停在 running，
 * 侧栏永远转圈（R-04 §1.4）；渲染进程重载后，正在跑的对话更会被显示成空闲。
 */
function thread(id: string, state: Thread['state']): Thread {
  return {
    id,
    workspaceId: 'w1',
    title: '对话',
    titleSource: 'auto',
    posture: 'auto-edit',
    origin: 'user',
    state,
    hasSession: true,
    forkedFrom: null,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('线程列表喂运行态（R-04 §3.5）', () => {
  test('R-04 S9 refresh 之后 turns 快照里的 running 被认出来', async () => {
    const api = {
      listThreads: async () => [thread('t1', 'running'), thread('t2', 'idle')],
    } as unknown as ConversationApi
    const turnStates = createTurnStatesStore()
    const threads = createThreadsStore(api, turnStates)

    await threads.refresh()

    expect(turnStates.isRunning('t1')).toBe(true)
    expect(turnStates.isRunning('t2')).toBe(false)
    expect(turnStates.runningCount()).toBe(1)
  })

  test('R-04 S9b 请求期间到达的通知不被旧快照覆盖', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const api = {
      listThreads: async () => {
        await gate
        /* 快照是请求出发那一刻的：idle。 */
        return [thread('t1', 'idle')]
      },
    } as unknown as ConversationApi
    const turnStates = createTurnStatesStore()
    const threads = createThreadsStore(api, turnStates)

    const pending = threads.refresh()
    /* 往返期间 Core 推来「这条对话正在跑」：它比快照新。 */
    turnStates.set({ threadId: 't1', state: 'running', error: null, startedAt: 1 })
    release()
    await pending

    expect(turnStates.isRunning('t1')).toBe(true)
  })

  test('列表请求失败时不打底、也不动已有状态', async () => {
    let fail = true
    const api = {
      listThreads: async () => {
        if (fail) throw new Error('network down')
        return [thread('t1', 'running')]
      },
    } as unknown as ConversationApi
    const turnStates = createTurnStatesStore()
    const threads = createThreadsStore(api, turnStates)
    turnStates.set({ threadId: 't1', state: 'awaiting', error: null, startedAt: 3 })

    await threads.refresh()

    expect(turnStates.get('t1')?.state).toBe('awaiting')
    fail = false
    await threads.refresh()
    expect(turnStates.get('t1')?.state).toBe('running')
  })
})
