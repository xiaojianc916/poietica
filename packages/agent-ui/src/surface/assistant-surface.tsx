import './assistant.css'

import type { FeedRow } from '@poietica/agent'
import type { AgentSessionPort, SessionConfigControl, SessionUsage } from '@poietica/agent-contract'
import { memo, type Ref, useCallback, useMemo, useState } from 'react'
import { AssistantComposer } from '../composer/assistant-composer'
import type { ComposerSkill } from '../composer/composer-actions'
import { useDockClearance } from '../composer/dock-clearance'
import type { PermissionDockProps } from '../composer/permission-dock'
import type { PromptInputHandle } from '../composer/prompt-input'
import { useMcpServers, useThreadSkills } from '../session/session-controls-context'
import type { AssistantSubmission } from '../session/use-assistant-session'
import {
  useAssistantPending,
  useAssistantPendingCall,
  useAssistantPendingCount,
  useAssistantQuestion,
  useAssistantSession,
} from '../session/use-assistant-session'
import { GitBranchPicker, type GitBranchPickerProps } from '../threads/git-branch-picker'
import { WorkspacePicker, type WorkspacePickerProps } from '../threads/workspace-picker'
import { TimelineRow } from '../timeline/timeline-row'
import { TranscriptView } from '../timeline/transcript-view'
import { MascotBadge } from './mascot/mascot-badge'

export interface AssistantSurfaceProps {
  readonly endpoint: string | null
  readonly identify?: (() => Promise<string | null>) | undefined
  readonly session?: AgentSessionPort
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
  readonly onFork?: (() => void) | undefined
  readonly controls: readonly SessionConfigControl[]
  readonly controlsFailure?: string | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly onRetryControls?: (() => void) | undefined
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
  readonly git?: GitBranchPickerProps | undefined
  readonly usage?: SessionUsage | undefined
  readonly composer?: Ref<PromptInputHandle> | undefined
  /** 入口态的技能目录；会话建立后改读该会话自己的目录。 */
  readonly entrySkills: readonly ComposerSkill[]
}

export const AssistantSurface = memo(function AssistantSurface({
  composer,
  controls,
  controlsFailure,
  endpoint,
  entrySkills,
  git,
  identify,
  onFork,
  onRetryControls,
  onSelectControl,
  onUserMessage,
  session,
  usage,
  workspace,
}: AssistantSurfaceProps) {
  const assistant = useAssistantSession({ endpoint, identify, onUserMessage, session })

  /* 两个 scope 各认自己的真相：入口读安装目录，会话读 agent 报告。 */
  const threadSkills = useThreadSkills(endpoint)
  const skills = endpoint === null ? entrySkills : threadSkills
  const mcpServers = useMcpServers()

  const dockRef = useDockClearance()
  const blocked = useAssistantPending(assistant.key)
  const waiting = useAssistantPendingCount(assistant.key)
  const call = useAssistantPendingCall(assistant.key)
  const question = useAssistantQuestion(assistant.key)

  const approval = useMemo<PermissionDockProps | null>(() => {
    if (blocked === undefined) {
      return null
    }

    return { call, item: blocked, onResolve: assistant.resolvePermission, waiting }
  }, [assistant.resolvePermission, blocked, call, waiting])

  const [phase, setPhase] = useState<'entry' | 'live'>(() => (endpoint === null ? 'entry' : 'live'))
  const [seen, setSeen] = useState(endpoint)

  /* React 对 props 变化后复位本地状态的渲染期写法，避免 effect 后的一帧错位。 */
  if (seen !== endpoint) {
    setSeen(endpoint)
    setPhase(endpoint === null ? 'entry' : 'live')
  }

  const live = phase === 'live'
  const renderRow = useCallback((row: FeedRow) => <TimelineRow row={row} />, [])

  const submit = useCallback(
    (message: AssistantSubmission) => {
      setPhase('live')
      assistant.send(message)
    },
    [assistant.send],
  )

  const dock = (
    <div className="assistant-surface__composer">
      <AssistantComposer
        approval={approval}
        controls={controls}
        controlsFailure={controlsFailure}
        mcpServers={mcpServers}
        onAnswerQuestions={assistant.answerQuestions}
        onCancel={assistant.cancel}
        onDismissQuestions={assistant.dismissQuestions}
        onRetryControls={onRetryControls}
        onSelectControl={onSelectControl}
        onSubmit={submit}
        question={question}
        ref={composer}
        skills={skills}
        status={assistant.status}
        usage={usage}
      />
    </div>
  )

  return (
    <section
      className="assistant-surface"
      data-assistant-skin
      data-phase={live ? 'live' : 'entry'}
      data-restoring={assistant.isRestoring ? 'true' : undefined}
    >
      {live ? (
        <TranscriptView
          isRestoring={assistant.isRestoring}
          onFork={onFork}
          renderRow={renderRow}
          sessionKey={assistant.key}
        />
      ) : (
        <div className="assistant-surface__entry">
          <header className="assistant-masthead">
            <MascotBadge className="assistant-masthead__mascot" />
          </header>
        </div>
      )}

      <div className="assistant-surface__dock" ref={dockRef}>
        {dock}

        {live || workspace === undefined ? null : (
          <div className="assistant-surface__context">
            <WorkspacePicker {...workspace} placement="composer" />
            {git === undefined ? null : <GitBranchPicker {...git} />}
          </div>
        )}
      </div>

      {live ? null : <div className="assistant-surface__ballast" />}
    </section>
  )
})
