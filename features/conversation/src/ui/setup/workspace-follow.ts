import type { WorkspacesUi } from '@poietica/feature-workspaces/ui-api'
import type { NavigationService } from '@poietica/ui-kernel'
import type { ThreadsStore } from '../threads/threads-store'

/*
 * 「当前工作区」跟着路由派生：在某条对话的页面上，当前工作区就是这条对话的工作区。
 *
 * 原先只在 openThread 里命令式地 setActive 一次；启动时 preferences 恢复路由（navigation.restore）、后退 / 前进都不经过
 * openThread，于是坞里的审查、终端、文件读的是另一个工作区 —— 屏幕上是 A 项目的对话，右边画的却是 B 项目的改动。
 * 这里订阅路由与线程表两处（线程表可能晚于路由到达），哪一处变了都重算一遍；只在不一致时才写，不制造多余的通知。
 * 入口页与设置页不动它：那里的当前工作区是人在选择器里选的。
 */

export interface WorkspaceFollowDeps {
  readonly navigation: Pick<NavigationService, 'current' | 'subscribe'>
  readonly threads: Pick<ThreadsStore, 'store' | 'byId'>
  readonly workspaces: Pick<WorkspacesUi, 'store' | 'setActive'>
}

export const THREAD_SURFACE = 'conversation.thread'

export function followThreadWorkspace(d: WorkspaceFollowDeps): () => void {
  const sync = (): void => {
    const { route } = d.navigation.current()
    if (route.surface !== THREAD_SURFACE) return
    const thread = d.threads.byId(route.params.threadId ?? '')
    if (thread === undefined || d.workspaces.store.getState().activeId === thread.workspaceId) return
    d.workspaces.setActive(thread.workspaceId)
  }
  const offRoute = d.navigation.subscribe(sync)
  const offThreads = d.threads.store.subscribe(sync)
  sync()
  return () => {
    offRoute()
    offThreads()
  }
}
