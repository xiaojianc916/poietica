import { AssistantThreadList } from '@poietica/agent-ui'
import { isProjectlessWorkspaceRoot } from '@poietica/core'
import { memo, useCallback, useMemo } from 'react'

import { useThreadsActions, useThreadsList } from '../assistant/threads-context'
import { toggleWorkspace, useCollapsedWorkspaces } from '../assistant/workspace-collapse'
import { setActiveWorkspaceRoot } from '../workspace-root'

/*
 * 侧栏的会话列表。
 *
 * 这里不再把记录二次加工成行：名字的三个来源在 store 里就已经分出胜负，
 * 列表项的引用也由 store 负责保持——值没变的行拿到的是同一个对象。加上
 * 下面这些回调各自钉住了标识，行组件的浅比较才第一次真的有东西可比。
 *
 * 此前这里每次渲染都 map 出一批新对象，五个回调全是内联箭头，于是行组件
 * 上的 memo 一次都没有命中过：时钟跳一下、上游任何一个 store 动一下，整张
 * 列表连同每一行各自持有的菜单根都要重建。
 *
 * 分组同理不在这里算：它由 useThreadsList 一次性派生好，引用随数据走。
 *
 * 加号点在哪个组头上，就先切到哪个工作区。
 *
 * 这里此前写着不分岔的理由：「等原生侧真的逐条记下目录，这里才有第二个答案可
 * 给」。那个前提已经兑现 —— threads 表有 workspace_root，桌面侧的对话桥也带着
 * cwd。前提没了还留着不分岔，就正好变成那句话要避免的事：界面写着「在 X 中新建
 * 对话」，开出来的却是当前那个目录。
 *
 * 工作目录本身在这一格上方选。「最近」那一列就是已经有对话的那些工作区 ——
 * 分组已经算好了，不需要第二份名单，也不需要第二处存储。
 */

export interface AssistantSidebarPanelProps {
  readonly activeThreadId: string | null
  readonly onCreate: () => void
  readonly onOpen: (threadId: string, title: string) => void
  readonly onOpenInNewTab: (threadId: string, title: string) => void
  readonly runningThreadIds: ReadonlySet<string>
}

/*
 * 记住不重建。
 *
 * 上面那段注释说的是为什么行组件能比：store 保持列表项引用，下面五个回调各自
 * 钉住标识。但那道护城河到这一层为止都没有城门 —— WorkspaceContainer 订的是
 * 整份工作台快照，切一次标签、关一次标签、拖动一次标签都让它重渲，而侧栏是它
 * JSX 里的一个裸组件。于是整张列表连同每一行的元素对象重建一遍，memo(ThreadRow)
 * 的浅比较照跑 N 次，每次都返回「相等」—— 代价全付，收益一点不取。
 *
 * 这一层的入参只有一个会真的变：activeThreadId。它变的时候列表本来就该重画
 * 高亮，其余时候这里应当一动不动。
 *
 * 「收起了哪些工作区」这份偏好在这里读。它有存储键、要跨窗口一致、一个进程只该
 * 有一份 —— 都是宿主的事实（application/ai/workspace-collapse），不是列表组件的
 * 内部记忆。往下只交出一个集合和一个动作，而 toggleWorkspace 是模块函数，引用
 * 天生稳定，memo 这道门不会因为多接一根线而失效。
 */
export const AssistantSidebarPanel = memo(function AssistantSidebarPanel({
  activeThreadId,
  onCreate,
  onOpen,
  onOpenInNewTab,
  runningThreadIds,
}: AssistantSidebarPanelProps) {
  const threads = useThreadsActions()
  const { failure, groups, isLoading } = useThreadsList()
  const collapsedWorkspaces = useCollapsedWorkspaces()

  const projectlessWorkspaces = useMemo(
    () =>
      new Set(
        groups.filter((group) => isProjectlessWorkspaceRoot(group.id)).map((group) => group.id),
      ),
    [groups],
  )

  /* 不点名工作区就是「当前那个」，点了名就先切过去 —— 见上面那段。 */
  const create = useCallback(
    (workspaceId?: string) => {
      if (workspaceId !== undefined) {
        setActiveWorkspaceRoot(workspaceId)
      }

      onCreate()
    },
    [onCreate],
  )

  const activate = useCallback(
    (threadId: string) => {
      onOpen(threadId, threads.titleOf(threadId))
    },
    [onOpen, threads],
  )

  const openInNewTab = useCallback(
    (threadId: string) => {
      onOpenInNewTab(threadId, threads.titleOf(threadId))
    },
    [onOpenInNewTab, threads],
  )

  const pin = useCallback(
    (threadId: string, pinned: boolean) => {
      void threads.setPinned(threadId, pinned)
    },
    [threads],
  )

  const rename = useCallback(
    (threadId: string, title: string) => {
      void threads.rename(threadId, title)
    },
    [threads],
  )

  const archive = useCallback(
    (threadId: string) => {
      void threads.archive(threadId, true)
    },
    [threads],
  )

  return (
    <div className="assistant-panel">
      <AssistantThreadList
        activeThreadId={activeThreadId}
        collapsedWorkspaces={collapsedWorkspaces}
        failure={failure}
        groups={groups}
        isLoading={isLoading}
        onActivate={activate}
        onArchive={archive}
        onCreate={create}
        onOpenInNewTab={openInNewTab}
        onPin={pin}
        onRename={rename}
        onToggleWorkspace={toggleWorkspace}
        projectlessWorkspaces={projectlessWorkspaces}
        runningThreadIds={runningThreadIds}
      />
    </div>
  )
})
