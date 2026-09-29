import { isProjectlessWorkspaceRoot } from '@poietica/conversation'
import { AssistantThreadList } from '@poietica/conversation/surface'
import { useCopy } from '@poietica/design-system'
import { memo, useCallback, useMemo, useState } from 'react'
import { useWorkspaceRoots } from '../workspace/roots-context'
import { useCollapsedWorkspaces, useThreadsActions, useThreadsList } from './threads-context'

export interface AssistantSidebarPanelProps {
  readonly activeThreadId: string | null
  readonly onCreate: () => void
  readonly onOpen: (threadId: string, title: string) => void
  readonly runningThreadIds: ReadonlySet<string>
}

export const AssistantSidebarPanel = memo(function AssistantSidebarPanel({
  activeThreadId,
  onCreate,
  onOpen,
  runningThreadIds,
}: AssistantSidebarPanelProps) {
  const threads = useThreadsActions()
  const { failure, groups, isLoading } = useThreadsList()
  const [collapsedWorkspaces, toggleWorkspace] = useCollapsedWorkspaces()
  const { copy } = useCopy()

  /*
   * 分享的结果，以及它属于哪一行。store 只记失败（failure 是整张列表共用的一句），
   * 成功要交出一段链接 —— 那是这一行的一次性事实，不进 store。
   */
  const [sharing, setSharing] = useState<string | null>(null)
  const [shared, setShared] = useState<{
    threadId: string
    url: string
    truncated: boolean
  } | null>(null)

  const projectlessWorkspaces = useMemo(
    () =>
      new Set(
        groups.filter((group) => isProjectlessWorkspaceRoot(group.id)).map((group) => group.id),
      ),
    [groups],
  )

  /* 不点名工作区就是「当前那个」，点了名就先切过去 —— 见上面那段。 */
  const { setActive: setActiveWorkspaceRoot } = useWorkspaceRoots()
  const create = useCallback(
    (workspaceId?: string) => {
      if (workspaceId !== undefined) {
        setActiveWorkspaceRoot(workspaceId)
      }

      onCreate()
    },
    [onCreate, setActiveWorkspaceRoot],
  )

  const activate = useCallback(
    (threadId: string) => {
      onOpen(threadId, threads.titleOf(threadId))
    },
    [onOpen, threads],
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

  const exportThread = useCallback(
    (threadId: string) => {
      void threads.export(threadId)
    },
    [threads],
  )

  /*
   * 上传要一次点击就兑现：链接同时落进剪贴板并显示在这一行下面，用户不必先读提示
   * 再手动复制。失败时剪贴板一个字都不写 —— 写进去的是上一次的旧链接。
   */
  const shareThread = useCallback(
    (threadId: string) => {
      setSharing(threadId)
      setShared(null)
      void threads.share(threadId).then((result) => {
        setSharing((busy) => (busy === threadId ? null : busy))
        if (result !== null) {
          copy(result.url)
          setShared({ threadId, url: result.url, truncated: result.truncated })
        }
      })
    },
    [copy, threads],
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
        onExport={exportThread}
        onPin={pin}
        onRename={rename}
        onShare={shareThread}
        onToggleWorkspace={toggleWorkspace}
        projectlessWorkspaces={projectlessWorkspaces}
        runningThreadIds={runningThreadIds}
        share={sharing}
        shared={shared}
      />
    </div>
  )
})
