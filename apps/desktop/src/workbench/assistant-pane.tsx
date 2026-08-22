import type { AgentSessionPort } from '@poietica/agent-contract'
import type { ComposerSkill, WorkspacePickerProps } from '@poietica/agent-ui'
import { isProjectlessWorkspaceRoot, workspaceRootName } from '@poietica/core'
import { createProjectlessWorkspace, pickWorkspaceRoot } from '@poietica/ipc'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useThreadsActions, useThreadsList } from '../assistant/threads-context'
import { useWorkspaceGit } from '../workspace-git'
import { setActiveWorkspaceRoot, useActiveWorkspaceRoot } from '../workspace-root'
import { ConversationSurface } from './conversation-surface'

/*
 * AI 表面：还没有指向任何一条已有对话的那一格，也就是“新建对话”。
 *
 * 它在人把手伸向输入框时才开一条对话，也才开一个 agent 会话（session/new）。
 * 说出第一句话之后这一格当场变成那条对话。
 */

export interface AssistantPaneProps {
  readonly entrySkills: readonly ComposerSkill[]
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
}

export function AssistantPane({ entrySkills, onConversationStarted, session }: AssistantPaneProps) {
  const open = useThreadsActions().create
  const { groups } = useThreadsList()
  const activeRoot = useActiveWorkspaceRoot()
  const git = useWorkspaceGit(activeRoot)

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

  const [threadId, setThreadId] = useState<string | null>(null)
  const opening = useRef<Promise<string | null> | null>(null)

  /* 第二次问等第一次的 promise：一格只开一条对话。 */
  const identify = useCallback(async (): Promise<string | null> => {
    opening.current ??=
      activeRoot === null
        ? createProjectlessWorkspace().then((root) => open(root))
        : open(activeRoot)

    const opened = await opening.current

    if (opened !== null) {
      setThreadId(opened)
    }

    return opened
  }, [activeRoot, open])

  return (
    <ConversationSurface
      entrySkills={entrySkills}
      git={git}
      onIdentify={identify}
      onStarted={onConversationStarted}
      session={session}
      threadId={threadId}
      workspace={workspace}
    />
  )
}
