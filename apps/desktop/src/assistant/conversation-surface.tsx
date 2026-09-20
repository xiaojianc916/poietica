import {
  type AgentSessionPort,
  projectVisibleModelChoices,
  type SessionConfigControl,
} from '@poietica/conversation'
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

const NONE: readonly SessionConfigControl[] = []

export interface ConversationSurfaceProps {
  readonly isNew: boolean
  readonly onPrepare?: (() => Promise<boolean>) | undefined
  readonly onStarted?: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly threadId: string
  readonly onForked?: ((threadId: string, title: string) => void) | undefined
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
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

  const usage = useThreadUsage(isNew ? null : threadId)

  useEffect(() => {
    if (isNew) {
      return
    }

    sessionControls.adopt(threadId)
  }, [isNew, sessionControls, threadId])

  const {
    controls: known,
    failure: knownFailure,
    provisional,
    retry,
    selectControl,
  } = useAgentControls()

  /* 盘上那份控件表属于上一次开窗、不属于这条对话；表回来之前宁可空着，也不拿它顶替。 */
  const sourceControls = isNew ? known : (offered ?? (provisional ? NONE : known))
  const hiddenModelAliases = useHiddenModelAliases()
  const controls = useMemo(
    () => projectVisibleModelChoices(sourceControls, hiddenModelAliases),
    [hiddenModelAliases, sourceControls],
  )

  const controlsPending = isNew && provisional

  const controlsFailure = isNew ? knownFailure : failure

  const retryControls = useCallback(
    () => (isNew ? retry() : sessionControls.retrySelectors(threadId)),
    [isNew, retry, sessionControls, threadId],
  )

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
      controlsPending={controlsPending}
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
