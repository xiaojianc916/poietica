import { type AgentSessionPort, projectVisibleModelChoices } from '@poietica/conversation'
import {
  AssistantSurface,
  type GitBranchPickerProps,
  type PromptInputHandle,
  useAgentControls,
  useSessionControlsActions,
  useThreadSelectorFailure,
  useThreadSelectors,
  useThreadUsage,
  type WorkspacePickerProps,
} from '@poietica/conversation/surface'
import { useHiddenModelAliases } from '@poietica/settings/ui'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useBrowserPick } from '../browser/pick-context'

import { useThreadsActions } from './threads-context'

export interface ConversationSurfaceProps {
  readonly isNew: boolean
  /** 第一条消息前把已铸造的标识写入平台。 */
  readonly onPrepare?: (() => Promise<boolean>) | undefined
  /** 这条对话说出第一句话时，带上它当时的名字。 */
  readonly onStarted?: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly threadId: string
  /** 分叉出的对话开出来之后，去它那里 —— 与打开列表里一条是同一个动作。 */
  readonly onForked?: ((threadId: string, title: string) => void) | undefined
  /** 只有新对话入口会交出这项。 */
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
  /** 工作目录的分支上下文，与 workspace 同来源同去处；不是仓库就没有。 */
  readonly git?: GitBranchPickerProps | undefined
}

export function ConversationSurface({
  git,
  isNew,
  onForked,
  onPrepare,
  onStarted,
  session,
  threadId,
  workspace,
}: ConversationSurfaceProps) {
  const threads = useThreadsActions()
  const browserPick = useBrowserPick()
  const composer = useRef<PromptInputHandle | null>(null)

  useEffect(() => browserPick.adopt(composer), [browserPick])

  const sessionControls = useSessionControlsActions()

  const offered = useThreadSelectors(isNew ? null : threadId)

  const failure = useThreadSelectorFailure(isNew ? null : threadId)

  /* 用量只属于真的对话：入口那一格没有会话可报数，胶囊整个不画。 */
  const usage = useThreadUsage(isNew ? null : threadId)

  useEffect(() => {
    if (isNew) {
      return
    }

    sessionControls.adopt(threadId)
  }, [isNew, sessionControls, threadId])

  const { controls: known, failure: knownFailure, retry, selectControl } = useAgentControls()

  const sourceControls = isNew ? known : (offered ?? known)
  const hiddenModelAliases = useHiddenModelAliases()
  const controls = useMemo(
    () => projectVisibleModelChoices(sourceControls, hiddenModelAliases),
    [hiddenModelAliases, sourceControls],
  )

  const controlsFailure = isNew ? knownFailure : failure

  /* 名册按会话回答，所以它跟着这一格走：入口是锚会话，进了对话就是那条会话。 */

  const retryControls = useCallback(() => {
    if (isNew) {
      retry()

      return
    }

    sessionControls.retrySelectors(threadId)
  }, [isNew, retry, sessionControls, threadId])

  /* 改一项，交给持有这张表的那一方：入口那格是锚会话，对话里是那条会话。 */
  const chooseControl = useCallback(
    (controlId: string, value: string, input?: string) => {
      if (isNew) {
        selectControl(controlId, value)

        return
      }

      sessionControls.selectControl(threadId, controlId, value, input)
    },
    [isNew, selectControl, sessionControls, threadId],
  )

  const userMessage = useCallback(
    (conversation: string, text: string) => {
      threads.noteUserMessage(conversation, text)
      onStarted?.(conversation, threads.standInTitle(text))
    },
    [onStarted, threads],
  )

  const fork = useCallback(
    (dropTurns: number) => {
      if (isNew) {
        return
      }

      void threads.fork(threadId, dropTurns).then((forked) => {
        if (forked !== null) {
          onForked?.(forked, threads.titleOf(forked))
        }
      })
    },
    [isNew, onForked, threadId, threads],
  )

  return (
    <AssistantSurface
      composer={composer}
      controls={controls}
      controlsFailure={controlsFailure}
      endpoint={threadId}
      git={git}
      isNew={isNew}
      onFork={isNew ? undefined : fork}
      onRetryControls={retryControls}
      onSelectControl={chooseControl}
      onUserMessage={userMessage}
      prepare={onPrepare}
      session={session}
      usage={usage}
      workspace={workspace}
    />
  )
}
