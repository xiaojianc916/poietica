import type { WorkspacePickerProps } from '@poietica/assistant'
import type { AgentSessionPort } from '@poietica/conversation'
import { isProjectlessWorkspaceRoot, workspaceRootName } from '@poietica/conversation'
import { createProjectlessWorkspace, pickWorkspaceRoot } from '@poietica/native-bridge'
import { useCallback, useMemo, useRef, useState } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { setActiveWorkspaceRoot, useActiveWorkspaceRoot } from '../entry/workspace-root'
import { ConversationSurface } from './conversation-surface'
import { useThreadsActions, useThreadsList } from './threads-context'
import { useWorkspaceGit } from './workspace-git'

/*
 * 同一组件身份承载新对话入口与已打开的对话。入口晋升到同一个 threadId 时，
 * ConversationSurface 不卸载；切到另一条对话时由 threadId key 重建会话局部状态。
 */
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
  /* 只要动作。这一格一个字的会话状态都不读，此前却订着整份快照。 */
  const open = useThreadsActions().create
  const { groups } = useThreadsList()
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
    void pickWorkspaceRoot().then((picked) => {
      if (picked !== null) {
        setActiveWorkspaceRoot(picked)
      }
    })
  }, [])

  const clearWorkspace = useCallback(() => {
    setActiveWorkspaceRoot(null)
  }, [])

  const workspace = useMemo<Omit<WorkspacePickerProps, 'placement'>>(
    () => ({
      choices,
      current,
      onBrowse: browse,
      onChoose: setActiveWorkspaceRoot,
      onClear: clearWorkspace,
    }),
    [browse, choices, clearWorkspace, current],
  )

  const [entry, setEntry] = useState(() => ({ threadId: uuidv7(), started: false }))
  const [previousThreadId, setPreviousThreadId] = useState<string | undefined>(threadId)
  const creating = useRef<Promise<boolean> | null>(null)

  if (threadId !== previousThreadId) {
    setPreviousThreadId(threadId)

    if (threadId === undefined && previousThreadId !== undefined) {
      creating.current = null
      setEntry({ threadId: uuidv7(), started: false })
    }
  }

  const isEntry = threadId === undefined
  const activeThreadId = threadId ?? entry.threadId

  const prepare = useCallback((): Promise<boolean> => {
    const pending = creating.current
    if (pending !== null) {
      return pending
    }

    const created = (
      activeRoot === null
        ? createProjectlessWorkspace().then((root) => open(activeThreadId, root))
        : open(activeThreadId, activeRoot)
    ).then((opened) => {
      const ready = opened !== null
      if (ready) {
        setEntry((current) =>
          current.threadId === activeThreadId ? { ...current, started: true } : current,
        )
      }
      return ready
    })

    creating.current = created
    void created.catch(() => {
      if (creating.current === created) {
        creating.current = null
      }
    })

    return created
  }, [activeRoot, activeThreadId, open])

  return (
    <ConversationSurface
      git={isEntry ? git : undefined}
      isNew={isEntry && !entry.started}
      key={activeThreadId}
      onForked={isEntry ? undefined : onConversationForked}
      onPrepare={isEntry ? prepare : undefined}
      onStarted={onConversationStarted}
      session={session}
      threadId={activeThreadId}
      workspace={isEntry ? workspace : undefined}
    />
  )
}
