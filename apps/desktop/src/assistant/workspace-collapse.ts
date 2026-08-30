import { createPreference } from '@poietica/external-store'
import { warn } from '@poietica/problem'
import { useSyncExternalStore } from 'react'

/*
 * 哪些工作区是收起来的。
 *
 * 住在应用层，不住在 agent-ui 里。它是一份用户偏好：有存储键、有跨窗口语义、
 * 一个进程里只该有一份 —— 这三件事都是宿主的事实，而 agent-ui 是一包展示组件。
 * 列表只收一个集合和一个动作：展示组件不绑死模块级可变状态，因此同一份列表在
 * 一个进程里画两次不会互相打断，也能在没有 Web Storage 的环境里渲染。
 *
 * 存储机制归 createPreference，这个文件只声明形状：一个字符串集合，读坏了等于
 * 「没收起过任何一个」—— 一份坏掉的偏好不该让侧栏打不开。
 */

const EMPTY: ReadonlySet<string> = new Set()

const FAILURE = {
  read: '读不出工作区折叠偏好',
  write: '写不进工作区折叠偏好',
}

const collapsed = createPreference<ReadonlySet<string>>({
  key: 'poietica.threads.collapsedWorkspaces',
  fallback: EMPTY,
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw)

    return Array.isArray(parsed) ? new Set(parsed.filter((id) => typeof id === 'string')) : EMPTY
  },
  encode: (value) => JSON.stringify([...value]),
  onFailure: ({ stage, cause }) => {
    warn(FAILURE[stage], { scope: 'workspace-collapse', cause })
  },
})

/** 收起了哪些工作区。返回的集合在值没变时恒是同一个引用。 */
export function useCollapsedWorkspaces(): ReadonlySet<string> {
  return useSyncExternalStore(collapsed.subscribe, collapsed.read, collapsed.readFallback)
}

/** 收起或展开一个工作区。模块函数，引用稳定，可以直接当 prop 往下传。 */
export function toggleWorkspace(id: string): void {
  const next = new Set(collapsed.read())

  if (!next.delete(id)) {
    next.add(id)
  }

  collapsed.write(next)
}
