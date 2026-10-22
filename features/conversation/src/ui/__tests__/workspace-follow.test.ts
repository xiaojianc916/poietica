import { describe, expect, test } from 'bun:test'
import { followThreadWorkspace, THREAD_SURFACE } from '../setup/workspace-follow'

type Route = { surface: string; params: Record<string, string> }

function make(initial: Route, threads: { id: string; workspaceId: string }[] = []) {
  let route = initial
  let items = threads
  let activeId: string | null = 'w0'
  const routeListeners = new Set<() => void>()
  const threadListeners = new Set<() => void>()
  const writes: (string | null)[] = []
  const stop = followThreadWorkspace({
    navigation: {
      current: () => ({ route }) as never,
      subscribe: (listener) => {
        routeListeners.add(listener)
        return () => {
          routeListeners.delete(listener)
        }
      },
    },
    threads: {
      byId: (id) => items.find((thread) => thread.id === id) as never,
      store: {
        subscribe: (listener: () => void) => {
          threadListeners.add(listener)
          return () => {
            threadListeners.delete(listener)
          }
        },
      } as never,
    },
    workspaces: {
      store: { getState: () => ({ items: [], activeId }) } as never,
      setActive: (id) => {
        activeId = id
        writes.push(id)
      },
    },
  })
  return {
    writes,
    stop,
    go(next: Route) {
      route = next
      for (const listener of [...routeListeners]) listener()
    },
    threadsArrive(next: { id: string; workspaceId: string }[]) {
      items = next
      for (const listener of [...threadListeners]) listener()
    },
    listeners: () => routeListeners.size + threadListeners.size,
  }
}

const thread = (threadId: string): Route => ({ surface: THREAD_SURFACE, params: { threadId } })

describe('当前工作区跟着路由派生', () => {
  test('落在某条对话上（含恢复路由、后退 / 前进）：当前工作区就是它的工作区', () => {
    const follow = make(thread('t1'), [
      { id: 't1', workspaceId: 'w1' },
      { id: 't2', workspaceId: 'w2' },
    ])
    expect(follow.writes).toEqual(['w1'])
    follow.go(thread('t2'))
    follow.go(thread('t1'))
    expect(follow.writes).toEqual(['w1', 'w2', 'w1'])
  })

  test('已经一致不写（不制造多余的通知）', () => {
    const follow = make(thread('t1'), [{ id: 't1', workspaceId: 'w0' }])
    follow.go(thread('t1'))
    expect(follow.writes).toEqual([])
  })

  test('线程表晚于路由到达：到达时补上', () => {
    const follow = make(thread('t1'))
    expect(follow.writes).toEqual([])
    follow.threadsArrive([{ id: 't1', workspaceId: 'w1' }])
    expect(follow.writes).toEqual(['w1'])
  })

  test('入口页、设置页不动它（那里是人在选择器里选的）；停掉后不再订阅', () => {
    const follow = make({ surface: 'conversation.home', params: {} }, [{ id: 't1', workspaceId: 'w1' }])
    follow.go({ surface: 'settings', params: { page: 'general' } })
    expect(follow.writes).toEqual([])
    follow.stop()
    expect(follow.listeners()).toBe(0)
  })
})
