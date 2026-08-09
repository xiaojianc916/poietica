import type { AgentSessionPort } from '@poietica/agent-contract'
import type { WorkspacePickerProps } from '@poietica/agent-ui'
import { workspaceRootName } from '@poietica/core'
import { pickWorkspaceRoot } from '@poietica/ipc'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useThreadsActions, useThreadsList } from '../assistant/threads-context'
import { setActiveWorkspaceRoot, useActiveWorkspaceRoot } from '../workspace-root'
import { ConversationSurface } from './conversation-surface'

/*
 * AI 表面：还没有指向任何一条已有对话的那一格，也就是“新建对话”。
 *
 * 它在人把手伸向输入框时才开一条对话，也才开一个 agent 会话（session/new）。
 *
 * 「开口之前就能看能改模型」这条要求是对的，Zed 的 agent panel、Copilot Chat、
 * Cursor 都是这样。但它论证不了在这一格出现的那一帧就 spawn 一个进程：指针移到
 * 输入框上，到手真的落下去改模型，中间足够握完手。挂在出现上，代价就变成了
 * 「看一眼都要启动一个 agent」，而这一格出现得比人想说话频繁得多。
 *
 * 于是也就没有「开了又走开」这回事了：没说过话的对话根本不会被建出来，不需要
 * list_threads 那个 WHERE EXISTS 去替它遮丑。
 *
 * 它仍然不预支身份：id 由平台给出，拿到了才用。此前是挂载时先用一个占位 id
 * 顶着，占位 id 会漏进名字、标签和 prompt，而它对应的对话并不存在。
 *
 * 说出第一句话之后这一格就不再是“新建对话”了：它当场变成那条对话，标签标题、
 * 侧边栏那一行的高亮都由工作台的同一次 openConversation 得出。
 */

export interface AssistantPaneProps {
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
}

export function AssistantPane({ onConversationStarted, session }: AssistantPaneProps) {
  /* 只要动作。这一格一个字的会话状态都不读，此前却订着整份快照。 */
  const open = useThreadsActions().create
  const { groups } = useThreadsList()
  const activeRoot = useActiveWorkspaceRoot()

  /*
   * 最近工作区不另存一份：已经存在对话的工作区就是最近使用过的工作区。
   */
  const choices = useMemo(
    () =>
      groups.flatMap((group) => (group.name === null ? [] : [{ id: group.id, name: group.name }])),
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

  const workspace = useMemo<Omit<WorkspacePickerProps, 'placement'>>(
    () => ({
      choices,
      current,
      onBrowse: browse,
      onChoose: setActiveWorkspaceRoot,
    }),
    [browse, choices, current],
  )

  const [threadId, setThreadId] = useState<string | null>(null)
  const opening = useRef<Promise<string | null> | null>(null)

  /*
   * 一格只开一条对话，哪怕连着说两句。
   *
   * 第二次问等的是第一次那个 promise，所以不会开出两条对话，也不会有两条
   * 都自称是这一格。
   */
  const identify = useCallback(async (): Promise<string | null> => {
    opening.current ??= open()

    const opened = await opening.current

    if (opened !== null) {
      setThreadId(opened)
    }

    return opened
  }, [open])

  return (
    <ConversationSurface
      onIdentify={identify}
      onStarted={onConversationStarted}
      session={session}
      threadId={threadId}
      workspace={workspace}
    />
  )
}
