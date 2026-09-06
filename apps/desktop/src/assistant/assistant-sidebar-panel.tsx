import { isProjectlessWorkspaceRoot } from '@poietica/conversation'
import { AssistantThreadList } from '@poietica/conversation/surface'
import { memo, useCallback, useMemo } from 'react'
import { useWorkspaceRoots } from '../workspace/roots-context'
import { useCollapsedWorkspaces, useThreadsActions, useThreadsList } from './threads-context'

export interface AssistantSidebarPanelProps {
  readonly activeThreadId: string | null
  readonly onCreate: () => void
  readonly onOpen: (threadId: string, title: string) => void
  readonly onOpenInNewTab: (threadId: string, title: string) => void
  readonly runningThreadIds: ReadonlySet<string>
}

export const AssistantSidebarPanel = memo(function AssistantSidebarPanel({
  activeThreadId,
  onCreate,
  onOpen,
  onOpenInNewTab,
  runningThreadIds,
}: AssistantSidebarPanelProps) {
  const threads = useThreadsActions()
  const { failure, groups, isLoading } = useThreadsList()
  const [collapsedWorkspaces, toggleWorkspace] = useCollapsedWorkspaces()

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

  const exportThread = useCallback(
    (threadId: string) => {
      void threads.export(threadId)
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
        onExport={exportThread}
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
