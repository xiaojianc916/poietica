import '../shared/styles/surface.css'

import { Banner, WorkspacePicker, type WorkspacePickerProps } from '@poietica/design-system'
import { FeatureScope, useContributions, useKernel, useObservable } from '@poietica/ui-kernel'
import {
  memo,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Thread } from '../../contract'
import { composerContextItems, slashCommands, threadHeaderItems } from '../../ui-api'
import type { PermissionDockProps, PromptInputHandle, PromptInputMessage } from '../composer'
import {
  AssistantComposer,
  ComposerDraftKeyContext,
  ComposerNotice,
  PromptQueue,
  SwarmToggle,
  useAgentToolkit,
  useDockClearance,
} from '../composer'
import type { ThreadCommands } from '../shared/model/commands'
import type { SessionConfigControl } from '../shared/model/config'
import type { SessionGoal } from '../shared/model/goal'
import type { GoalActionHandler } from '../shared/model/goal-control'
import type { AgentSessionPort, WithdrawnMessage } from '../shared/model/session'
import type { AgentToolkit } from '../shared/model/toolkit'
import type { SessionUsage } from '../shared/model/usage'
import type { PlanItem, QuestionTimelineItem } from '../shared/timeline/timeline-contract'
import {
  CONVERSATION_STATUS_PANEL_LAYOUT_STYLE,
  ConversationStatusPanel,
  EntryNotices,
  type GoalActions,
  GoalBar,
  type SummaryPanelPreference,
  useGoalActions,
} from '../status'
import { ThreadTitleMenu } from '../threads'
import type { PreparedThread } from '../timeline'
import { type AssistantSession, TranscriptView, useAssistantInteractions, useAssistantSession } from '../timeline'
import { type SlashCommandsView, useSlashCommands } from './command-dispatch'
import { EmotionBall, ENTRY_EMOTION_GROUPS } from './mascot/emotion-ball'

/* 连不上 agent 时输入区上沿那一句；原文（controlsFailure）只做 title。 */
const DISCONNECTED = '没连上 agent，点击重试'

/* 没选项目时 banner 里那句话。只在这一刻说，不做常驻 UI。 */
const PROJECT_REQUIRED = '先选择或新建一个项目，才能发送消息'

export interface AssistantSurfaceProps {
  readonly endpoint: string
  readonly isNew: boolean
  readonly prepare?: (() => Promise<PreparedThread | null>) | undefined
  /** 故意可选：缺席时整个表面挂在一份惰性 stub 上跑，真端口由 app 注入。 */
  readonly session?: AgentSessionPort
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
  readonly onFork?: ((keepTurns: number) => void) | undefined
  /** 从某一轮重写：由组合根分出新对话并把那一句放回新对话的输入框 */
  readonly onRewrite?: ((turn: number) => void) | undefined
  /** 进这条对话时要放进输入框的一句（重写带过来的那句话）；每条对话只放一次 */
  readonly prefill?: string | undefined
  readonly onPinThread?: ((threadId: string, pinned: boolean) => void) | undefined
  readonly onRenameThread?: ((threadId: string, title: string) => void) | undefined
  readonly onExportThread?: ((threadId: string) => void) | undefined
  readonly onShareThread?: ((threadId: string) => void) | undefined
  /** 复制这条对话的 omp Session ID（菜单里那一项）。 */
  readonly onCopySessionId?: ((threadId: string) => void) | undefined
  readonly controls: readonly SessionConfigControl[]
  readonly controlsPending?: boolean | undefined
  readonly controlsFailure?: string | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly onRetryControls?: (() => void | Promise<void>) | undefined
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
  /**
   * 还没选项目时，输入区上方那条提示与发送禁用都要靠它。入口页传 `workspace.current === null`；
   * 对话页不传（那条对话已经有项目，切换项目不该让已经发生的对话不能说话）。
   */
  readonly workspaceRequired?: boolean | undefined
  readonly usage?: SessionUsage | undefined
  readonly goal?: SessionGoal | undefined
  readonly onGoalAction?: GoalActionHandler | undefined
  readonly composer?: Ref<PromptInputHandle> | undefined
  /**
   * 人开始写这一句（输入框拿到焦点、拖进文件）：对话页据此预热会话（性能方案 P4，看不开、写才开）。会反复触发，去重归调用方；
   * 入口页不传。
   */
  readonly onComposeIntent?: (() => void) | undefined
  /** 这条对话的斜杠命令（omp 的表与执行）；入口页没有会话，缺席 */
  readonly commands?: ThreadCommands | undefined
  readonly thread?: Thread | undefined
  /** 状态面板形态偏好（null = auto）；草稿态不传，面板因此不挂载。 */
  readonly summaryPanelVariant?: SummaryPanelPreference | undefined
}

const NO_GOAL_ACTIONS: GoalActionHandler = () => Promise.resolve({ ok: false, error: '这条对话还没有会话' })

/* 包一层是因为钩子不能写在三目里：useObservable 必须无条件调用。 */
function StatusPanelLayer({
  endpoint,
  goal,
  goalActions,
  summaryPanelVariant,
}: {
  readonly endpoint: string
  readonly goal: SessionGoal | undefined
  readonly goalActions: GoalActions
  readonly summaryPanelVariant: SummaryPanelPreference
}): ReactNode {
  const variant = useObservable(summaryPanelVariant)

  return (
    <ConversationStatusPanel
      goal={goal}
      onPauseGoal={() => {
        void goalActions.run({ kind: 'pause' })
      }}
      onResumeGoal={() => {
        void goalActions.run({ kind: 'resume' })
      }}
      onVariantChange={(next) => {
        summaryPanelVariant.set(next)
      }}
      threadId={endpoint}
      variant={variant}
    />
  )
}

/*
 * 输入区一整块：目标条、失败横幅、队列、前置条件与输入框。表面本体只负责相位与装配，
 * 这些条件都在这里判，免得主组件被渲染分支撑爆。
 */
function AssistantDock({
  approval,
  assistant,
  composer,
  controls,
  controlsFailure,
  controlsPending,
  continueConversation,
  dismissed,
  dismissFailure,
  edit,
  failure,
  goal,
  goalActions,
  live,
  onComposeIntent,
  onRetryControls,
  onSelectControl,
  pendingPlan,
  question,
  recoverable,
  showProjectRequired,
  slash,
  submit,
  submitDisabled,
  toolkit,
  usage,
}: {
  readonly approval: PermissionDockProps | null
  readonly assistant: AssistantSession
  readonly composer: (handle: PromptInputHandle | null) => void
  readonly controls: readonly SessionConfigControl[]
  readonly controlsFailure: string | undefined
  readonly controlsPending: boolean | undefined
  readonly continueConversation: () => void
  readonly dismissed: boolean
  readonly dismissFailure: () => void
  readonly edit: (restored: WithdrawnMessage) => void
  readonly failure: string | null
  readonly goal: SessionGoal | undefined
  readonly goalActions: GoalActions
  readonly live: boolean
  readonly onComposeIntent: (() => void) | undefined
  readonly onRetryControls: (() => void | Promise<void>) | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly pendingPlan: PlanItem | null
  readonly question: QuestionTimelineItem | null | undefined
  readonly recoverable: string | null
  readonly showProjectRequired: () => void
  readonly slash: SlashCommandsView
  readonly submit: (message: PromptInputMessage) => void
  readonly submitDisabled: boolean
  readonly toolkit: AgentToolkit
  readonly usage: SessionUsage | undefined
}) {
  const { mcpServers, skills } = toolkit

  return (
    <div className="assistant-surface__composer">
      {live && goal !== undefined ? <GoalBar actions={goalActions} goal={goal} /> : null}

      {failure === null || dismissed ? null : (
        <Banner
          {...(recoverable === null
            ? {}
            : { actions: [{ label: '取回文字', onClick: () => edit({ text: recoverable, attachments: [] }) }] })}
          holdMs={FAILURE_HOLD_MS}
          key={failure}
          onDone={dismissFailure}
          text={failure}
          tone="error"
        />
      )}
      <PromptQueue onEdit={edit} queue={assistant.queue} />

      {/* 输入区上沿的两条前置条件：连不上 agent / 还没选项目。 */}
      <ComposerPreconditions controlsFailure={controlsFailure} onRetryControls={onRetryControls} />

      <AssistantComposer
        approval={approval}
        commands={slash.list}
        contextPanelRequest={slash.contextPanelRequest}
        controls={controls}
        controlsPending={controlsPending}
        mcpServers={mcpServers}
        modelPickerRequest={slash.modelPickerRequest}
        onAnswerDialog={assistant.answerDialog}
        onAnswerQuestions={assistant.answerQuestions}
        onCancel={assistant.cancel}
        onContinue={continueConversation}
        onDismissQuestions={assistant.dismissQuestions}
        onEngage={onComposeIntent}
        onResolvePlan={assistant.resolvePlan}
        plan={pendingPlan}
        onSelectControl={onSelectControl}
        onSubmit={submit}
        onSubmitBlocked={showProjectRequired}
        question={question}
        ref={composer}
        skills={skills}
        status={assistant.status}
        submitDisabled={submitDisabled}
        usage={usage}
      />
    </div>
  )
}

/* 入口页输入区上沿那排：在哪跑、本功能贡献的上下文、Swarm 勾选。会话态已经有明确落点，不再画。 */
function ComposerContextRow({
  controls,
  live,
  onSelectControl,
  pending,
  workspace,
}: {
  readonly controls: readonly SessionConfigControl[]
  readonly live: boolean
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly pending: boolean | undefined
  readonly workspace: AssistantSurfaceProps['workspace']
}): ReactNode {
  if (live || workspace === undefined) {
    return null
  }

  return (
    <div className="composer-context">
      <WorkspacePicker {...workspace} placement="composer" />

      <ComposerContextContributed />

      {/* 最右端：左边两枚说「在哪跑」，它说「这一句怎么跑」。 */}
      <SwarmToggle controls={controls} onSelect={onSelectControl} pending={pending} />
    </div>
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

/* 别的功能贡献的斜杠命令（/mcp、/usage……）：贡献表的引用随注册变化，拍平成命令本体交给清单 */
function useContributedCommands() {
  const contributions = useContributions(slashCommands)
  return useMemo(() => contributions.map(({ item }) => item), [contributions])
}

/** 本机的乐观记录优先，其次是 Core 库里那一行 —— 排队 / 插话只有后者。 */
function recoverableTextOf(assistant: AssistantSession): string | null {
  const failed = assistant.submissions.find((submission) => submission.phase === 'failed')
  return failed?.text ?? assistant.failedSubmissionText
}

/** 重写带过来的那一句：输入框挂好之后放一次；换了对话（标签页复用同一实例）再放那一条的 */
function usePrefill(draft: RefObject<PromptInputHandle | null>, endpoint: string, prefill: string | undefined) {
  const placed = useRef<string | null>(null)
  useEffect(() => {
    if (prefill === undefined || prefill === '' || placed.current === endpoint) return
    placed.current = endpoint
    draft.current?.restore(prefill, [])
  }, [draft, endpoint, prefill])
}

/* 连不上 agent：卡上沿一条提示，不在工具栏里冒充模型选择器。还没选项目不画常驻提示 —— 只有真的按发送时才用横幅说一次。 */
function ComposerPreconditions({
  controlsFailure,
  onRetryControls,
}: {
  readonly controlsFailure: string | undefined
  readonly onRetryControls: (() => void | Promise<void>) | undefined
}): ReactNode {
  return controlsFailure === undefined ? null : (
    <ComposerNotice detail={controlsFailure} message={DISCONNECTED} onRetry={onRetryControls} />
  )
}
/* 提交这一句：搬出组件是为了让表面本体只留装配（复杂度上限 20）。 */
function useSubmit({
  assistant,
  routeCommand,
  setPhase,
  onBlocked,
  workspaceRequired,
}: {
  readonly assistant: AssistantSession
  readonly routeCommand: (message: Omit<PromptInputMessage, 'queued'>) => boolean
  readonly setPhase: (phase: 'entry' | 'live') => void
  readonly onBlocked: () => void
  readonly workspaceRequired: boolean
}): (message: PromptInputMessage) => void {
  return useCallback(
    ({ queued, ...message }: PromptInputMessage) => {
      /* 没有项目就没有收件人：不转场、不发，草稿留在输入框里等用户先选项目。 */
      if (workspaceRequired) {
        onBlocked()
        return
      }
      /*
       * 命令先认：认下了就不转场 —— 入口页敲 `/model`、`/settings` 不该把页面切成一条空对话（真实故障）。
       * 交给模型的那类命令（/review）会铸出对话并跳过去，转场由那条对话的表面负责。
       */
      if (routeCommand(message)) {
        return
      }
      setPhase('live')
      /* 失败由横幅说：正常发送不看回执。 */
      void assistant.send(message, queued === true ? 'followUp' : undefined)
    },
    [assistant.send, onBlocked, routeCommand, workspaceRequired, setPhase],
  )
}

/* 相位是显式的，不由转录反推：转录里任何一帧变动都能搬动整块构成。转录归 TranscriptView。 */
export const AssistantSurface = memo(function AssistantSurface({
  commands,
  composer,
  controls,
  controlsFailure,
  controlsPending,
  endpoint,
  goal,
  isNew,
  onComposeIntent,
  onExportThread,
  onCopySessionId,
  onFork,
  onShareThread,
  onGoalAction = NO_GOAL_ACTIONS,
  onPinThread,
  onRenameThread,
  onRetryControls,
  onRewrite,
  onSelectControl,
  onUserMessage,
  prefill,
  prepare,
  session,
  summaryPanelVariant,
  thread,
  usage,
  workspace,
  workspaceRequired = false,
}: AssistantSurfaceProps) {
  const kernel = useKernel()
  const showProjectRequired = useCallback(() => {
    kernel.kernelServices.banners.show({ severity: 'warning', title: PROJECT_REQUIRED })
  }, [kernel])

  const assistant = useAssistantSession({ endpoint, onUserMessage, prepare, session })

  /* 技能按 cwd 分层（omp 扫工作区）；线程行还没到（点头一帧）时退到全局活动工作区。 */
  const toolkit = useAgentToolkit(thread?.workspaceId ?? workspace?.current?.id ?? null)

  /* 连不上 agent 不在这层写：由 threads-store 打开对话失败时的 catch 统一记，与帧流里的失败同一个样子。 */
  const { permission: blocked, permissionCount: waiting, plan, question } = useAssistantInteractions(assistant.key)

  /* 目标动作的在途与失败：目标栏与状态面板共用这一份（审查 R-10）。 */
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

  /* 把手两个读者：外面写草稿，这层取回队列那句改；铺一条回调 ref 分给两边。 */
  const draft = useRef<PromptInputHandle | null>(null)
  const restoreDraft = useCallback((text: string) => {
    draft.current?.restore(text, [])
  }, [])
  const slash = useSlashCommands({
    commands,
    contributed: useContributedCommands(),
    controls,
    controlsPending,
    endpoint,
    isNew,
    onExportThread,
    onRenameThread,
    onSelectControl,
    onShareThread,
    restore: restoreDraft,
    services: kernel.kernelServices,
    status: assistant.status,
    statusPanel: summaryPanelVariant,
    thread,
    usage,
  })

  /* 发言就是那次转场，先于 send：这一刻起就是对话而非入口。`queued` 是人点名的「排队」，跑着时走 followUp 不打断。 */
  const submit = useSubmit({
    assistant,
    onBlocked: showProjectRequired,
    routeCommand: slash.route,
    setPhase,
    workspaceRequired,
  })

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

  usePrefill(draft, endpoint, prefill)

  /* 撤回的那一句（正文 + 附件）回输入框改：改完重发就是重新投一次（队列的顺序归 agent，本机不预演）。 */
  const edit = useCallback((restored: WithdrawnMessage) => {
    draft.current?.restore(restored.text, restored.attachments)
  }, [])

  /* KAP 没有恢复同一轮的协议动作；这里发送一条可见新消息，不伪装成断流重建。 */
  const continueConversation = useCallback(() => {
    draft.current?.insertTextAndSubmit('Continue')
  }, [])

  /* 输入框只挂一处，不属于任何一个相位：相位切换时它的 DOM 位置不变，草稿、附件、光标与焦点跨相位存活。 */
  const dock = (
    <AssistantDock
      approval={approval}
      assistant={assistant}
      composer={composerRef}
      controls={controls}
      controlsFailure={controlsFailure}
      controlsPending={controlsPending}
      continueConversation={continueConversation}
      dismissed={dismissed}
      dismissFailure={dismissFailure}
      edit={edit}
      failure={failure}
      goal={goal}
      goalActions={goalActions}
      live={live}
      onComposeIntent={onComposeIntent}
      onRetryControls={onRetryControls}
      onSelectControl={onSelectControl}
      pendingPlan={pendingPlan}
      question={question}
      recoverable={recoverable}
      showProjectRequired={showProjectRequired}
      slash={slash}
      submit={submit}
      submitDisabled={workspaceRequired}
      toolkit={toolkit}
      usage={usage}
    />
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
        <ThreadTitleMenu
          onExport={onExportThread}
          onPin={onPinThread}
          onCopySessionId={onCopySessionId}
          onShare={onShareThread}
          onRename={onRenameThread}
          renameRequest={slash.renameRequest}
          thread={thread}
          titling={slash.titling}
        />

        <ThreadHeaderItems thread={thread} />
      </div>

      {/*
        正文列。结构与 workbench 的 workspace.tsx 逐字相同（就是 conversation-body /
        conversation-canvas 这两层，形状照抄别处、改它有风险）：输入框浮起时以画布为包含块。
      */}
      {/* 几何常量（--conversation-status-panel-width 320px / -gap 16px）写在正文列上：
          浮层本体与 @container 那条让位规则都从这一层继承。 */}
      <div className="conversation-body" style={CONVERSATION_STATUS_PANEL_LAYOUT_STYLE}>
        <div className="conversation-canvas">
          {/* 页头与转录之间的雾，是正文盒顶部那一条。 */}
          <div className="conversation-veil" data-assistant-skin />

          {live ? (
            <TranscriptView
              dockClearance={clearance.value}
              onFork={onFork}
              onRetry={slash.retry}
              onRewrite={onRewrite}
              sessionKey={assistant.key}
            />
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
            状态面板：没有内容时组件自己返回 null（包括干净仓库 + 空待办）；让位走
            --assistant-surface-inline-end-clearance 的容器查询。形态偏好由 /todo 命令或面板
            自身的展开 / 收起按钮写入，这里只读。
          */}
          {summaryPanelVariant === undefined ? null : (
            <StatusPanelLayer
              endpoint={endpoint}
              goal={goal}
              goalActions={goalActions}
              summaryPanelVariant={summaryPanelVariant}
            />
          )}

          <div className="assistant-surface__dock" ref={clearance.ref}>
            <ComposerDraftKeyContext value={draftKey}>{dock}</ComposerDraftKeyContext>

            {live || workspace === undefined ? null : (
              <ComposerContextRow
                controls={controls}
                live={live}
                onSelectControl={onSelectControl}
                pending={controlsPending}
                workspace={workspace}
              />
            )}
          </div>

          {/* 输入框下方的另一半自由空间。会话态没有它，所以输入框落在底部。 */}
          {live ? null : <div className="assistant-surface__ballast" />}
        </div>
      </div>
    </section>
  )
})
