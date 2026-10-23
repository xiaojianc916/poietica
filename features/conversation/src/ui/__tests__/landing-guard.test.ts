import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import type { Route } from '@poietica/ui-kernel'
import type { Thread } from '../../contract'
import { conversationErrors } from '../../contract/errors'
import { isGoneLanding, landingThreadOf, leaveMissingLanding } from '../setup/landing-guard'

/*
 * 「上次那条对话已经不在了」：路由在 setup 里就恢复（不等 Core），恢复出来的 threadId 可能已被删除或归档，
 * 线程页于是对着一条不存在的对话。首次 onCoreReady 里线程表到达之后判一次：确认不在了就回入口页（replace，不留死路由的历史）。
 */

const HOME: Route = { surface: 'conversation.home', params: {} }
const threadRoute = (threadId: string): Route => ({ surface: 'conversation.thread', params: { threadId } })

function thread(id: string, archived = false): Thread {
  return {
    id,
    workspaceId: 'w1',
    title: '对话',
    titleSource: 'auto',
    posture: 'auto-edit',
    origin: 'user',
    state: 'idle',
    hasSession: true,
    forkedFrom: null,
    pinned: false,
    archived,
    createdAt: 0,
    updatedAt: 0,
  }
}

function make(initial: Route, opts: { listed?: readonly Thread[]; get?: (threadId: string) => Promise<Thread> }) {
  let route = initial
  const navigations: { route: Route; replace: boolean }[] = []
  const asked: string[] = []
  const deps = {
    api: {
      getThread: (threadId: string) => {
        asked.push(threadId)
        return opts.get?.(threadId) ?? Promise.resolve(thread(threadId))
      },
    },
    navigation: {
      current: () => ({ route, canGoBack: false, canGoForward: false }),
      navigate: (next: Route, o?: { replace?: boolean }) => {
        route = next
        navigations.push({ route: next, replace: o?.replace === true })
      },
    },
    threads: { byId: (id: string) => opts.listed?.find((t) => t.id === id) },
  }
  return {
    deps,
    asked,
    navigations,
    route: () => route,
    go: (next: Route) => {
      route = next
    },
  }
}

const notFound = () => Promise.reject(new AppError(conversationErrors.thread_not_found, '对话不存在'))

describe('启动落地：上次那条对话已经不在了', () => {
  test('在活动列表里：不问 Core、不动', async () => {
    const h = make(threadRoute('t1'), { listed: [thread('t1')] })
    await leaveMissingLanding(h.deps)
    expect(h.asked).toEqual([])
    expect(h.navigations).toEqual([])
  })

  test('不在线程页：什么都不做', async () => {
    const h = make(HOME, {})
    await leaveMissingLanding(h.deps)
    expect(h.asked).toEqual([])
    expect(h.navigations).toEqual([])
  })

  test('已经删了（thread_not_found）：replace 回入口页', async () => {
    const h = make(threadRoute('gone'), { listed: [thread('t1')], get: notFound })
    await leaveMissingLanding(h.deps)
    expect(h.asked).toEqual(['gone'])
    expect(h.navigations).toEqual([{ route: HOME, replace: true }])
  })

  test('已经归档（侧栏默认不显示它的行）：回入口页', async () => {
    const h = make(threadRoute('t9'), { get: async (id) => thread(id, true) })
    await leaveMissingLanding(h.deps)
    expect(h.navigations).toEqual([{ route: HOME, replace: true }])
  })

  test('列表只是没带它（刷新失败），Core 说它还在且没归档：不动', async () => {
    const h = make(threadRoute('t9'), {})
    await leaveMissingLanding(h.deps)
    expect(h.asked).toEqual(['t9'])
    expect(h.navigations).toEqual([])
  })

  test('其它失败（Core 又掉了、超时）：拿不准就不赶人', async () => {
    const h = make(threadRoute('t9'), { get: () => Promise.reject(new Error('timeout')) })
    await leaveMissingLanding(h.deps)
    expect(h.navigations).toEqual([])
  })

  test('问 Core 期间人已经换了页：不把人从新页面拽走', async () => {
    let answer: (() => void) | null = null
    const h = make(threadRoute('gone'), {
      get: () =>
        new Promise<Thread>((_, reject) => {
          answer = () => reject(new AppError(conversationErrors.thread_not_found, '对话不存在'))
        }),
    })
    const running = leaveMissingLanding(h.deps)
    h.go(threadRoute('t2'))
    ;(answer as (() => void) | null)?.()
    await running
    expect(h.navigations).toEqual([])
    expect(h.route()).toEqual(threadRoute('t2'))
  })

  test('判据：线程号取自路由；只有 thread_not_found 与 archived 算不在了', () => {
    expect(landingThreadOf(threadRoute('t1'))).toBe('t1')
    expect(landingThreadOf({ surface: 'conversation.thread', params: {} })).toBeNull()
    expect(landingThreadOf(HOME)).toBeNull()
    expect(isGoneLanding({ thread: thread('t1') })).toBe(false)
    expect(isGoneLanding({ thread: thread('t1', true) })).toBe(true)
    expect(isGoneLanding({ error: new AppError(conversationErrors.thread_not_found, 'x') })).toBe(true)
    expect(isGoneLanding({ error: new AppError('other', 'x') })).toBe(false)
    expect(isGoneLanding({ error: new Error('x') })).toBe(false)
  })
})
