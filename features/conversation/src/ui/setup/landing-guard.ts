import { isAppError } from '@poietica/foundation'
import type { NavigationService, Route } from '@poietica/ui-kernel'
import type { Thread } from '../../contract'
import { conversationErrors } from '../../contract/errors'
import { THREAD_SURFACE } from './workspace-follow'

const HOME: Route = { surface: 'conversation.home', params: {} }

/** 当前路由指着哪条对话；不在线程页时为 null（与 actions.ts 的 activeThreadOfRoute、workspace-follow 同一判据）。 */
export function landingThreadOf(route: Route): string | null {
  if (route.surface !== THREAD_SURFACE) return null
  const threadId = route.params.threadId
  return threadId === undefined || threadId === '' ? null : threadId
}

/**
 * 向 Core 确认的结果 → 要不要让位：
 * - `thread_not_found`：那条对话已经删了（别的窗口、上一次没删完、库被换了）；
 * - `archived`：它还在，但侧栏（默认不显示归档）没有它的行 —— 与 leaveForArchive 同一条规则（用户 2026-10-19：
 *   停在一个已归档的会话里是自相矛盾的）；
 * - 其它失败（Core 又掉了、超时）**不动**：拿不准的时候不把人从他上次停的地方赶走。
 */
export function isGoneLanding(outcome: { readonly thread: Thread } | { readonly error: unknown }): boolean {
  if ('thread' in outcome) return outcome.thread.archived
  return isAppError(outcome.error) && outcome.error.code === conversationErrors.thread_not_found
}

export interface LandingGuardDeps {
  readonly api: { readonly getThread: (threadId: string) => Promise<Thread> }
  readonly navigation: Pick<NavigationService, 'current' | 'navigate'>
  readonly threads: { readonly byId: (threadId: string) => Thread | undefined }
}

/*
 * 「上次那条对话已经不在了」：路由在 preferences 的 setup 里就恢复（不等 Core），恢复出来的 threadId 可能已被删除或归档，
 * 线程页于是对着一条不存在的对话（空时间线、请求全报 thread_not_found）。只有 conversation 知道线程表，所以这一判放在这里：
 * 首次 onCoreReady 里 threads.refresh 之后跑。
 * - 在活动列表里 → 什么都不做（绝大多数情况，零请求）；
 * - 不在 → 列表可能只是没带它（归档 / 刷新失败），用 threads.get 问一次 Core 再定；
 * - 要让位时用 replace：不在历史里留一条「后退回死路由」；await 期间人已经换了页就不动（不把人从新页面拽走）。
 */
export async function leaveMissingLanding({ api, navigation, threads }: LandingGuardDeps): Promise<void> {
  const threadId = landingThreadOf(navigation.current().route)
  if (threadId === null || threads.byId(threadId) !== undefined) return
  const outcome = await api.getThread(threadId).then(
    (thread) => ({ thread }),
    (error: unknown) => ({ error }),
  )
  if (!isGoneLanding(outcome)) return
  if (landingThreadOf(navigation.current().route) !== threadId) return
  navigation.navigate(HOME, { replace: true })
}
