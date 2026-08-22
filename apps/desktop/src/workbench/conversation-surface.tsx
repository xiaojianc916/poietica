import type { AgentSessionPort } from '@poietica/agent-contract'
import {
  AssistantSurface,
  type ComposerSkill,
  type GitBranchPickerProps,
  type PromptInputHandle,
  useAgentControls,
  useSessionControlsActions,
  useThreadSelectorFailure,
  useThreadSelectors,
  useThreadUsage,
  type WorkspacePickerProps,
} from '@poietica/agent-ui'
import { useCallback, useEffect, useRef } from 'react'
import { useThreadsActions } from '../assistant/threads-context'
import { adoptBrowserPickTarget } from '../browser/browser-pick'

export interface ConversationSurfaceProps {
  /** 新对话入口在第一句话发出时取得身份。 */
  readonly onIdentify?: (() => Promise<string | null>) | undefined
  readonly onStarted?: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly threadId: string | null
  readonly onForked?: ((threadId: string, title: string) => void) | undefined
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
  readonly git?: GitBranchPickerProps | undefined
  /** 新会话建立前，以受控 home 的 skills/ 目录为真相。 */
  readonly entrySkills: readonly ComposerSkill[]
}

export function ConversationSurface({
  entrySkills,
  git,
  onForked,
  onIdentify,
  onStarted,
  session,
  threadId,
  workspace,
}: ConversationSurfaceProps) {
  const threads = useThreadsActions()
  const composer = useRef<PromptInputHandle | null>(null)

  useEffect(() => adoptBrowserPickTarget(composer), [])

  const sessionControls = useSessionControlsActions()
  const offered = useThreadSelectors(threadId)
  const failure = useThreadSelectorFailure(threadId)
  const usage = useThreadUsage(threadId)

  /* 已有对话打开即装载；入口在真正发言或切模式时才认领身份。 */
  useEffect(() => {
    if (threadId !== null) {
      sessionControls.adopt(threadId)
    }
  }, [sessionControls, threadId])

  const { controls: known, failure: knownFailure, retry, selectControl } = useAgentControls()
  const controls = threadId === null ? known : (offered ?? known)
  const controlsFailure = threadId === null ? knownFailure : failure

  const retryControls = useCallback(() => {
    if (threadId === null) {
      retry()
      return
    }

    sessionControls.retrySelectors(threadId)
  }, [retry, sessionControls, threadId])

  const chooseControl = useCallback(
    (controlId: string, value: string, input?: string) => {
      const control = controls.find((candidate) => candidate.id === controlId)

      if (threadId === null && control?.purpose === 'mode') {
        void onIdentify?.().then((identified) => {
          if (identified !== null && identified !== undefined) {
            sessionControls.selectControl(identified, controlId, value, input)
          }
        })
        return
      }

      if (threadId === null) {
        selectControl(controlId, value)
        return
      }

      sessionControls.selectControl(threadId, controlId, value, input)
    },
    [controls, onIdentify, selectControl, sessionControls, threadId],
  )

  const userMessage = useCallback(
    (conversation: string, text: string) => {
      threads.noteUserMessage(conversation, text)
      onStarted?.(conversation, threads.standInTitle(text))
    },
    [onStarted, threads],
  )

  const fork = useCallback(() => {
    if (threadId === null) {
      return
    }

    void threads.fork(threadId).then((forked) => {
      if (forked !== null) {
        onForked?.(forked, threads.titleOf(forked))
      }
    })
  }, [onForked, threadId, threads])

  return (
    <AssistantSurface
      composer={composer}
      controls={controls}
      controlsFailure={controlsFailure}
      endpoint={threadId}
      entrySkills={entrySkills}
      git={git}
      identify={onIdentify}
      onFork={threadId === null ? undefined : fork}
      onRetryControls={retryControls}
      onSelectControl={chooseControl}
      onUserMessage={userMessage}
      session={session}
      usage={usage}
      workspace={workspace}
    />
  )
}
