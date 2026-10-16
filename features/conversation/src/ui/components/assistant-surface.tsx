import './surface.css'

import { Banner } from '@poietica/design-system'
import { WorkspacePicker, type WorkspacePickerProps } from '@poietica/feature-workspaces/ui-api'
import { FeatureScope, type Observable, useContributions, useObservable } from '@poietica/ui-kernel'
import { memo, type ReactNode, type Ref, useCallback, useMemo, useRef, useState } from 'react'
import type { Thread } from '../../contract'
import { composerContextItems, threadHeaderItems } from '../../ui-api'
import type { SessionConfigControl } from '../agent/config'
import type { SessionGoal } from '../agent/goal'
import type { AgentSessionPort } from '../agent/session'
import type { SessionUsage } from '../agent/usage'
import { ComposerDraftKeyContext } from '../composer/drafts-context'
import type { PromptInputMessage } from '../composer/prompt'
import { useAgentToolkit } from '../configuration/composer-toolkit'
import type { PlanItem } from '../timeline/timeline-contract'
import type { PreparedThread } from '../transcript/transcript-store'
import {
  type AssistantSession,
  useAssistantInteractions,
  useAssistantSession,
} from '../transcript/use-assistant-session'
import { AssistantComposer } from './composer/assistant-composer'
import { ComposerNotice } from './composer/composer-notice'
import { useDockClearance } from './composer/dock-clearance'
import type { PermissionDockProps } from './composer/permission-dock'
import type { PromptInputHandle } from './composer/prompt-input'
import { SwarmToggle } from './composer/swarm-toggle'
import { EntryNotices } from './entry-notices'
import { type GoalActions, GoalBar, useGoalActions } from './goal/goal-bar'
import type { GoalActionHandler } from './goal/goal-control'
import { EmotionBall, ENTRY_EMOTION_GROUPS } from './mascot/emotion-ball'
import { PromptQueue } from './prompt-queue'
import { ThreadTitleMenu } from './threads/thread-title-menu'
import { TranscriptView } from './timeline/transcript-view'
import { CONVERSATION_TODO_LAYOUT_STYLE, ConversationTodoPopover } from './todo/conversation-todo-popover'

/* 连不上 agent 时输入区上沿那一句；原文（controlsFailure）只做 title。 */
const DISCONNECTED = '没连上 agent，点击重试'

export interface AssistantSurfaceProps {
  readonly endpoint: string
  readonly isNew: boolean
  readonly prepare?: (() => Promise<PreparedThread | null>) | undefined
  /** 故意可选：缺席时整个表面挂在一份惰性 stub 上跑，真端口由 app 注入。 */
  readonly session?: AgentSessionPort
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
  readonly onFork?: ((keepTurns: number) => void) | undefined
  readonly onPinThread?: ((threadId: string, pinned: boolean) => void) | undefined
  readonly onRenameThread?: ((threadId: string, title: string) => void) | undefined
  readonly onExportThread?: ((threadId: string) => void) | undefined
  readonly controls: readonly SessionConfigControl[]
  readonly controlsPending?: boolean | undefined
  readonly controlsFailure?: string | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly onRetryControls?: (() => void | Promise<void>) | undefined
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
  readonly usage?: SessionUsage | undefined
  readonly goal?: SessionGoal | undefined
  readonly onGoalAction?: GoalActionHandler | undefined
  readonly composer?: Ref<PromptInputHandle> | undefined
  readonly thread?: Thread | undefined
  readonly todoThread?: (Observable<string | null> & { set(next: string | null): void }) | undefined
}

const NO_GOAL_ACTIONS: GoalActionHandler = () => Promise.resolve({ ok: false, error: '这条对话还没有会话' })

/* 包一层是因为钩子不能写在三目里：useObservable 必须无条件调用。 */
function TodoPopoverLayer({
  endpoint,
  goal,
  goalActions,
  todoThread,
}: {
  readonly endpoint: string
  readonly goal: SessionGoal | undefined
  readonly goalActions: GoalActions
  readonly todoThread: Observable<string | null> & { set(next: string | null): void }
}): ReactNode {
  const open = useObservable(todoThread)

  return (
    <ConversationTodoPopover
      expanded={open === endpoint}
      goal={goal}
      onCollapse={() => {
        todoThread.set(null)
      }}
      onPauseGoal={() => {
        void goalActions.run({ kind: 'pause' })
      }}
      onResumeGoal={() => {
        void goalActions.run({ kind: 'resume' })
      }}
      threadId={endpoint}
    />
  )
}

/* 这条带子必须留着：它是内容区的固定高度与底色，也是 usage「累计用量」的落点。 */
function ThreadHeaderItems({ thread }: { readonly thread: Thread | undefined }): ReactNode {
  const contributions = useContributions(threadHeaderItems)

  if (thread === undefined || contributions.length === 0) {
    return null
  }

  return contributions.map(({ featureId, item }) => {
    const Component = item.component

    return (
      <FeatureScope featureId={featureId} key={item.id}>
        <Component thread={thread} />
      </FeatureScope>
    )
  })
}

/** 分支胶囊由 review 贡献：conversation 不认识 git，review 也不该认识输入框排版。 */
function ComposerContextContributed(): ReactNode {
  const contributions = useContributions(composerContextItems)

  if (contributions.length === 0) {
    return null
  }

  return contributions.map(({ featureId, item }) => {
    const Component = item.component

    return (
      <FeatureScope featureId={featureId} key={item.id}>
        <Component />
      </FeatureScope>
    )
  })
}

/* 渲染期直接改 state 是 React 官方的「props 变了复位 state」写法：换一句就重新开始。 */
function useDismissed(message: string | null): readonly [boolean, () => void] {
  const [dismissed, setDismissed] = useState<string | null>(null)

  if (dismissed !== null && dismissed !== message) {
    setDismissed(null)
  }

  return [
    message !== null && dismissed === message,
    useCallback(() => {
      setDismissed(message)
    }, [message]),
  ]
}

/** **不走**淡出：后面挂着未了的事（取回正文重发）；Banner 无「永久」档，所以报一个够长的数。 */
const FAILURE_HOLD_MS = 60 * 60 * 1000

/** 本机的乐观记录优先，其次是 Core 库里那一行 —— 排队 / 插话只有后者。 */
function recoverableTextOf(assistant: AssistantSession): string | null {
  const failed = assistant.submissions.find((submission) => submission.phase === 'failed')
  return failed?.text ?? assistant.failedSubmissionText
}

/* 相位是显式的，不由转录反推：转录里任何一帧变动都能搬动整块构成。转录归 TranscriptView。 */
export const AssistantSurface = memo(function AssistantSurface({
  composer,
  controls,
  controlsFailure,
  controlsPending,
  endpoint,
  goal,
  isNew,
  onExportThread,
  onFork,
  onGoalAction = NO_GOAL_ACTIONS,
  onPinThread,
  onRenameThread,
  onRetryControls,
  onSelectControl,
  onUserMessage,
  prepare,
  session,
  thread,
  todoThread,
  usage,
  workspace,
}: AssistantSurfaceProps) {
  const assistant = useAssistantSession({ endpoint, onUserMessage, prepare, session })

  /* 技能按 cwd 分层（omp 扫工作区）；线程行还没到（点头一帧）时退到全局活动工作区。 */
  const { mcpServers, skills } = useAgentToolkit(thread?.workspaceId ?? workspace?.current?.id ?? null)

  /* 连不上 agent 不在这层写：由 threads-store 打开对话失败时的 catch 统一记，与帧流里的失败同一个样子。 */
  const { permission: blocked, permissionCount: waiting, plan, question } = useAssistantInteractions(assistant.key)

  /* 目标动作的在途与失败：目标栏与任务浮层共用这一份（审查 R-10）。 */
  const goalActions = useGoalActions(onGoalAction, goal?.objective)

  /* 整副入参当成一个 prop：引用只随「换了请求」或「分母变了」而变，流式追加动不了被 memo 过的 composer。 */
  const approval = useMemo<PermissionDockProps | null>(() => {
    if (blocked === undefined) {
      return null
    }

    return { item: blocked, onResolve: assistant.resolvePermission, waiting }
  }, [assistant.resolvePermission, blocked, waiting])

  const pendingPlan = useMemo<PlanItem | null>(() => plan ?? null, [plan])

  const [phase, setPhase] = useState<'entry' | 'live'>(() => (isNew ? 'entry' : 'live'))

  /* 两个来源合成一句话，因为它们对人是同一件事；补救只有一个动作 —— 把正文取回输入框。 */
  const recoverable = recoverableTextOf(assistant)
  const failure = assistant.notice ?? (recoverable === null ? null : '提交未完成；请先核对会话。')
  const [dismissed, dismissFailure] = useDismissed(failure)

  /* 相位是派生的：标签页复用同一实例，换对话进来时 endpoint 已变而相位还停在上一条。 */
  const [seenNew, setSeenNew] = useState(isNew)

  if (seenNew !== isNew) {
    setSeenNew(isNew)
    setPhase(isNew ? 'entry' : 'live')
  }

  const live = phase === 'live'
  const clearance = useDockClearance(live)

  const draftKey = endpoint

  /* 发言就是那次转场，先于 send：这一刻起就是对话而非入口。`queued` 是人点名的「排队」，跑着时走 followUp 不打断。 */
  const submit = useCallback(
    ({ queued, ...message }: PromptInputMessage) => {
      setPhase('live')
      /* 失败由横幅说：正常发送不看回执。 */
      void assistant.send(message, queued === true ? 'followUp' : undefined)
    },
    [assistant.send],
  )

  /* 把手两个读者：外面写草稿，这层取回队列那句改；铺一条回调 ref 分给两边。 */
  const draft = useRef<PromptInputHandle | null>(null)

  const composerRef = useCallback(
    (handle: PromptInputHandle | null) => {
      draft.current = handle

      if (typeof composer === 'function') {
        composer(handle)
      } else if (composer !== null && composer !== undefined) {
        composer.current = handle
      }
    },
    [composer],
  )

  /* 撤回的那一句回输入框改：改完重发就是重新投一次（队列的顺序归 agent，本机不预演）。 */
  const edit = useCallback((text: string) => {
    draft.current?.setText(text)
    draft.current?.focus()
  }, [])

  /* KAP 没有恢复同一轮的协议动作；这里发送一条可见新消息，不伪装成断流重建。 */
  const continueConversation = useCallback(() => {
    draft.current?.insertTextAndSubmit('Continue')
  }, [])

  /* 输入框只挂一处，不属于任何一个相位：相位切换时它的 DOM 位置不变，草稿、附件、光标与焦点跨相位存活。 */
  const dock = (
    <div className="assistant-surface__composer">
      {live && goal !== undefined ? <GoalBar actions={goalActions} goal={goal} /> : null}

      {failure === null || dismissed ? null : (
        <Banner
          {...(recoverable === null ? {} : { actions: [{ label: '取回文字', onClick: () => edit(recoverable) }] })}
          holdMs={FAILURE_HOLD_MS}
          key={failure}
          onDone={dismissFailure}
          text={failure}
          tone="error"
        />
      )}
      <PromptQueue onEdit={edit} queue={assistant.queue} />

      {/* 连不上 agent：卡上沿一条提示，不在工具栏里冒充模型选择器。 */}
      {controlsFailure === undefined ? null : (
        <ComposerNotice detail={controlsFailure} message={DISCONNECTED} onRetry={onRetryControls} />
      )}

      <AssistantComposer
        approval={approval}
        controls={controls}
        controlsPending={controlsPending}
        mcpServers={mcpServers}
        onAnswerQuestions={assistant.answerQuestions}
        onCancel={assistant.cancel}
        onContinue={continueConversation}
        onDismissQuestions={assistant.dismissQuestions}
        onResolvePlan={assistant.resolvePlan}
        plan={pendingPlan}
        onSelectControl={onSelectControl}
        onSubmit={submit}
        question={question}
        ref={composerRef}
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
      /* 相位写到 DOM 上：样式表按相位分家，输入框只在会话态浮起 —— 这个布尔值不能只留在闭包里。 */
      data-phase={live ? 'live' : 'entry'}
      data-restoring={assistant.isRestoring ? 'true' : undefined}
    >
      {/* 内容区固定的那一条（36px 高、地色底），两个相位都在；右端是 threadHeaderItems 的落点。 */}
      <div className="conversation-header" data-assistant-skin>
        {/* 机器图标 + 标题 + 下拉菜单（固定 / 重命名 / 导出 + 其它功能贡献的动作）；标题跟着线程库走。 */}
        <ThreadTitleMenu onExport={onExportThread} onPin={onPinThread} onRename={onRenameThread} thread={thread} />

        <ThreadHeaderItems thread={thread} />
      </div>

      {/*
        正文列。结构与 workbench 的 workspace.tsx 逐字相同（就是 conversation-body /
        conversation-canvas 这两层，形状照抄别处、改它有风险）：输入框浮起时以画布为包含块。
      */}
      {/* 几何常量（--conversation-todo-width 320px / --conversation-todo-gap 12px）写在正文列上：
          浮层本体与 @container 那条让位规则都从这一层继承。 */}
      <div className="conversation-body" style={CONVERSATION_TODO_LAYOUT_STYLE}>
        <div className="conversation-canvas">
          {/* 页头与转录之间的雾，是正文盒顶部那一条。 */}
          <div className="conversation-veil" data-assistant-skin />

          {live ? (
            <TranscriptView dockClearance={clearance.value} onFork={onFork} sessionKey={assistant.key} />
          ) : (
            <div className="assistant-surface__entry">
              {/* 提示画在入口区顶部，吉祥物仍钉在输入框上方（入口区 justify-content: flex-end）；
                  贡献点住在 ui-kernel，这里不认识任何功能。 */}
              <div className="assistant-surface__entry-notices">
                <EntryNotices />
              </div>

              <header className="assistant-masthead">
                <EmotionBall
                  className="assistant-masthead__mascot"
                  emotion="02"
                  label="球球吉祥物，点击旋转"
                  placement="entry"
                  tour={ENTRY_EMOTION_GROUPS}
                />
              </header>
            </div>
          )}

          {/*
            任务与后台任务浮层：让位走 --assistant-surface-inline-end-clearance 的容器查询。
            开合由页头那枚开关写 todoThread，这里只读。同一件事只有一条写入路径。
          */}
          {todoThread === undefined ? null : (
            <TodoPopoverLayer endpoint={endpoint} goal={goal} goalActions={goalActions} todoThread={todoThread} />
          )}

          <div className="assistant-surface__dock" ref={clearance.ref}>
            <ComposerDraftKeyContext value={draftKey}>{dock}</ComposerDraftKeyContext>

            {live || workspace === undefined ? null : (
              <div className="composer-context">
                <WorkspacePicker {...workspace} placement="composer" />

                <ComposerContextContributed />

                {/* 最右端：左边两枚说「在哪跑」，它说「这一句怎么跑」。 */}
                <SwarmToggle controls={controls} onSelect={onSelectControl} pending={controlsPending} />
              </div>
            )}
          </div>

          {/* 输入框下方的另一半自由空间。会话态没有它，所以输入框落在底部。 */}
          {live ? null : <div className="assistant-surface__ballast" />}
        </div>
      </div>
    </section>
  )
})
