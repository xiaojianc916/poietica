import type { AgentSessionPort } from '@poietica/conversation'
import { isProjectlessWorkspaceRoot, workspaceRootName } from '@poietica/conversation'
import type { WorkspacePickerProps } from '@poietica/conversation/surface'
import { pickWorkspaceRoot } from '@poietica/native-bridge/workspace'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { reportFailure } from '../notice/problem-presentation'
import { useActiveWorkspaceRoot, useWorkspaceRoots } from '../workspace/roots-context'
import { ConversationSurface } from './conversation-surface'
import { useConversationEntry, useThreadsList } from './threads-context'
import { useWorkspaceGit } from './workspace-git'

export interface AssistantPaneProps {
  readonly onConversationForked: (threadId: string, title: string) => void
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly threadId?: string | undefined
}

export function AssistantPane({
  onConversationForked,
  onConversationStarted,
  session,
  threadId,
}: AssistantPaneProps) {
  const { groups } = useThreadsList()
  const { setActive: setActiveWorkspaceRoot } = useWorkspaceRoots()
  const activeRoot = useActiveWorkspaceRoot()

  /* 分支 chip 的数据与动作；不是 git 仓库时为 undefined，chip 整个不渲染。 */
  const git = useWorkspaceGit(activeRoot)

  /*
   * 最近工作区不另存一份：已经存在对话的工作区就是最近使用过的工作区。
   */
  const choices = useMemo(
    () =>
      groups.flatMap((group) =>
        group.name === null || isProjectlessWorkspaceRoot(group.id)
          ? []
          : [{ id: group.id, name: group.name }],
      ),
    [groups],
  )

  const current = useMemo(
    () =>
      activeRoot === null
        ? null
        : {
            id: activeRoot,
            name: workspaceRootName(activeRoot) ?? activeRoot,
          },
    [activeRoot],
  )

  const browse = useCallback(() => {
    void pickWorkspaceRoot()
      .then((picked) => {
        if (picked !== null) {
          setActiveWorkspaceRoot(picked)
        }
      })
      .catch((cause: unknown) => {
        reportFailure('WORKSPACE_PICK_FAILED', { cause, scope: 'assistant' })
      })
  }, [setActiveWorkspaceRoot])

  const clearWorkspace = useCallback(() => {
    setActiveWorkspaceRoot(null)
  }, [setActiveWorkspaceRoot])

  const workspace = useMemo<Omit<WorkspacePickerProps, 'placement'>>(
    () => ({
      choices,
      current,
      onBrowse: browse,
      onChoose: setActiveWorkspaceRoot,
      onClear: clearWorkspace,
    }),
    [browse, choices, clearWorkspace, current, setActiveWorkspaceRoot],
  )

  const entryOwner = useConversationEntry()
  const entry = useSyncExternalStore(
    entryOwner.subscribe,
    entryOwner.getSnapshot,
    entryOwner.getSnapshot,
  )
  const isEntry = threadId === undefined
  const activeThreadId = threadId ?? entry.threadId

  return (
    <ConversationSurface
      git={isEntry ? git : undefined}
      isNew={isEntry && !entry.started}
      key={activeThreadId}
      onForked={isEntry ? undefined : onConversationForked}
      onPrepare={isEntry ? entryOwner.prepare : undefined}
      onStarted={onConversationStarted}
      session={session}
      threadId={activeThreadId}
      workspace={isEntry ? workspace : undefined}
    />
  )
}
