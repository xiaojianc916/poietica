import './skin/surface.css'

import { Banner } from '@poietica/design-system'
import { WorkspacePicker, type WorkspacePickerProps } from '@poietica/feature-workspaces/ui-api'
import { FeatureScope, type Observable, useContributions, useObservable } from '@poietica/ui-kernel'
import { memo, type ReactNode, type Ref, useCallback, useMemo, useRef, useState } from 'react'
import type { Thread } from '../../contract'
import { composerContextItems, threadHeaderItems } from '../../ui-api'
import type { SessionConfigControl } from '../agent/config'
import type { SessionGoal } from '../agent/goal'
import type { AgentSessionPort, PromptDelivery } from '../agent/session'
import type { SessionUsage } from '../agent/usage'
import type { PromptInputMessage } from '../composer/prompt'
import { useAgentToolkit } from '../configuration/composer-toolkit'
import type { PlanItem } from '../timeline/timeline-contract'
import type { PreparedThread } from '../transcript/transcript-store'
import { AssistantComposer } from './composer/assistant-composer'
import { ComposerNotice } from './composer/composer-notice'
import { useDockClearance } from './composer/dock-clearance'
import { ComposerDraftKeyContext } from './composer/drafts-context'
import type { PermissionDockProps } from './composer/permission-dock'
import type { PromptInputHandle } from './composer/prompt-input'
import { SwarmToggle } from './composer/swarm-toggle'
import { EntryNotices } from './entry-notices'
import { GoalBar } from './goal/goal-bar'
import { GOAL_CONTROL_ID, GOAL_PAUSED, GOAL_RESUMED } from './goal/goal-control'
import { EmotionBall, ENTRY_EMOTION_GROUPS } from './mascot/emotion-ball'
import { PromptQueue } from './prompt-queue'
import { TranscriptView } from './timeline/transcript-view'
import { CONVERSATION_TODO_LAYOUT_STYLE, ConversationTodoPopover } from './todo/conversation-todo-popover'
import { useAssistantInteractions, useAssistantSession } from './transcript/use-assistant-session'

/* 连不上 agent 时输入区上沿那一句；原文（controlsFailure）只做 title。 */
const DISCONNECTED = '没连上 agent，点击重试'

export interface AssistantSurfaceProps {
  /** 这一格从出生起持有的稳定对话标识。 */
  readonly endpoint: string
  /** 是否尚未把这条对话写入平台。身份不参与这个生命周期判定。 */
  readonly isNew: boolean
  /** 第一条消息发送前铸号：交回这一条提交要落的键与它的端口（入口相位才有）。 */
  readonly prepare?: (() => Promise<PreparedThread | null>) | undefined
  /**
   * The session this surface talks to. Optional on purpose: without one the surface
   * renders against an inert stub (fixtures and component work); the desktop app
   * supplies the real IPC-backed port.
   */
  readonly session?: AgentSessionPort
  /**
   * What the user just said. The conversation list names a conversation from its first
   * message and does not own the list, so the surface reports it outwards.
   */
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
  /** 从某一轮分叉；dropTurns 是这一轮之后还有几轮。缺席 = 平台没有这个动作。 */
  readonly onFork?: ((dropTurns: number) => void) | undefined
  /** 这条对话的会话给出的选择器。它是被交进来的，不是在这里问出来的：选择器属于会话，会话由上层持有。 */
  readonly controls: readonly SessionConfigControl[]
  /** 这张表还没被 agent 确认过：画得出内容，但点不动，也不参与下发。 */
  readonly controlsPending?: boolean | undefined
  /** 没能连上 agent 时那句话的原样；只做提示条的 title，正文是 DISCONNECTED。 */
  readonly controlsFailure?: string | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  /** 重新连一次。交回这一趟的承诺：重试图标转多久由它说了算。 */
  readonly onRetryControls?: (() => void | Promise<void>) | undefined
  /** 新对话入口即将使用的工作目录。已有对话没有这项；第一句话发出后 entry 相位结束即卸载。 */
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
  /** 这条会话最近报的上下文用量。缺席（还没报、或是入口）就不画。 */
  readonly usage?: SessionUsage | undefined
  /**
   * 这条会话此刻的目标（从 Core 的控件通道来）。缺席整条不画 —— 与目标选择器同一份事实。
   */
  readonly goal?: SessionGoal | undefined
  /** 草稿的 ref 通道（浏览器拾取是第一个调用方）。所有者仍是 PromptInput，这层只铺通道不碰内容。 */
  readonly composer?: Ref<PromptInputHandle> | undefined
  /** 这条线程在平台上的整条记录；贡献点（threadHeaderItems）收的就是它。 */
  readonly thread?: Thread | undefined
  /**
   * 任务浮层此刻开着哪条对话（legacy workspace-layout 的 `todoThread`）。
   *
   * 它由组合根持有（见 ui/index.tsx 的 createValue）：页头那枚开关负责写，这里只读。
   * 缺席（没有组合根 / 单测夹具）时整块浮层不渲染。
   */
  readonly todoThread?: (Observable<string | null> & { set(next: string | null): void }) | undefined
}

/*
 * 任务浮层的订阅层。
 *
 * 单独一层是因为钩子不能写在三目里：`useObservable(todoThread)` 只有在 todoThread 存在时
 * 才允许被调用，而调用条件恰好取决于那个 prop —— 包一层，钩子就落在无条件的位置上。
 */
function TodoPopoverLayer({
  endpoint,
  goal,
  onSelectControl,
  todoThread,
}: {
  readonly endpoint: string
  readonly goal: SessionGoal | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
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
      onPauseGoal={() => onSelectControl(GOAL_CONTROL_ID, GOAL_PAUSED)}
      onResumeGoal={() => onSelectControl(GOAL_CONTROL_ID, GOAL_RESUMED)}
      threadId={endpoint}
    />
  )
}

/*
 * 线程标题栏右侧的小部件（07 页 §5E 的 threadHeaderItems）。
 *
 * legacy 的页头只是一条固定高度的空白带（conversation-header），右端两枚开合按钮由
 * 外壳栅格摆；新架构里那些属于 workbench。这条带子仍然要留着 —— 它是**内容区的固定
 * 高度与底色**，也是 usage「累计用量」的落点（review 的「N 个文件改动」已按产品负责人
 * 2026-10-07 的决定删除，refactor-log 偏差 #49）。
 */
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

/**
 * 输入框下方那一行的贡献 chip（07 页 §5E 的 composerContextItems）。
 *
 * 工作区胶囊由本表面自己画（它认识工作区），分支胶囊由 review 贡献：conversation 不
 * 认识 git，review 也不该认识输入框的排版（功能之间只经 ui-api 协作）。
 */
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

/*
 * 一句话横幅的「说完了」。
 *
 * 横幅自己走完之后不再挂回来；换一句（或那一句清掉）时重新开始 —— 渲染期直接改自己的
 * state 是 React 官方「props 变了复位 state」的写法，本次渲染内重跑，无闪烁也不需要 effect。
 *
 * 独立成钩子是让 AssistantSurface 的主干不超复杂度闸门，与 deltaOps 同理。
 */
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

/**
 * 一次失败该停多久。
 *
 * **不走**：这句话后面挂着一件没做完的事（把正文取回来重发），横幅自己淡出等于把那
 * 唯一的入口一起收走 —— 判据与 update-banner 的 `persistent` 同一条：有没有未了的事，
 * 不是时间长短。人重发或取回之后 `failure` 就变了，整条随之换掉，不必自己去清定时器。
 *
 * `Banner` 只认毫秒数，没有「永久」这一档，所以报一个够长的数。
 */
const FAILURE_HOLD_MS = 60 * 60 * 1000

/*
 * 两个静止态、两棵树、一个输入框。静止态由显式相位说了算，不由转录反推：把导航派生自
 * 内容，等于任何一帧内容变动都能搬动整块构成，且挂载与卸载不可补间、中间态无法表达。
 * 输入框始终是同一个 DOM 节点，两相位共用。这一层只订忙/历史/待答三样，模型吐字不动它；
 * 转录归 TranscriptView（唯一跟着帧率走的地方），几何仍然一概不量。
 */
export const AssistantSurface = memo(function AssistantSurface({
  composer,
  controls,
  controlsFailure,
  controlsPending,
  endpoint,
  goal,
  isNew,
  onFork,
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

  /*
   * 名册属于这条连接，不属于这一格：入口态也画得出来。技能按工作区分层（omp 按 cwd 扫），
   * 所以问的是**这一格此刻的工作区** —— 线程页是这条线程的工作区，入口页是草稿里选的那个。
   * 线程行还没到（点开对话的头一帧）时退到全局活动工作区：openThread 那一刻已经把它切过来了。
   */
  const { mcpServers, skills } = useAgentToolkit(thread?.workspaceId ?? workspace?.current?.id ?? null)

  /*
   * 连不上 agent 不在这一层写：threads-store 打开对话失败的同一个 catch 里既记控件格，
   * 也把经过交给转录（#transcripts?.failed）—— 它和帧流里的失败长同一个样子。
   */
  const { permission: blocked, permissionCount: waiting, plan, question } = useAssistantInteractions(assistant.key)

  /*
   * 待答的那一次审批。交出去的是那一格的整副入参而非三个各走各的 prop：引用只随
   * 「换了请求」或「分母变了」而变，流式追加动不了被 memo 过的 composer。
   */
  const approval = useMemo<PermissionDockProps | null>(() => {
    if (blocked === undefined) {
      return null
    }

    return { item: blocked, onResolve: assistant.resolvePermission, waiting }
  }, [assistant.resolvePermission, blocked, waiting])

  /* 待批准的那张计划卡片（04 页 §3.12 第 5 支）：一次一张，与审批/提问是三条各自的队列。 */
  const pendingPlan = useMemo<PlanItem | null>(() => plan ?? null, [plan])

  const [phase, setPhase] = useState<'entry' | 'live'>(() => (isNew ? 'entry' : 'live'))

  /*
   * 一次失败说成一句话。
   *
   * 两个来源合成一句，因为它们对人是同一件事「刚才那一下没成」：`notice` 是原生侧给
   * 的原因（投递没落地、这一轮没跑起来），failed 的提交是那一句话本身。分开画会变成
   * 截图里那样 —— 一段没有格式的裸字加一个列表，读不出哪句是原因、哪句是内容。
   *
   * 补救动作只有一个：把正文取回输入框。附件取不回（字节已入库，但重新选择才是对的），
   * 所以那句 title 只在这里说一次。
   */
  const failed = assistant.submissions.find((submission) => submission.phase === 'failed')
  const failure = assistant.notice ?? (failed === undefined ? null : '提交未完成；请先核对会话。')
  const [dismissed, dismissFailure] = useDismissed(failure)

  /*
   * 相位是派生的，不是记住的。标签页复用同一实例、换对话进来时 endpoint 已变而相位
   * 还在上一条 —— 渲染期直接改自己的 state 是 React 官方「props 变了复位 state」的
   * 写法，本次渲染内重跑，无闪烁也不需要 effect。
   */
  const [seenNew, setSeenNew] = useState(isNew)

  if (seenNew !== isNew) {
    setSeenNew(isNew)
    setPhase(isNew ? 'entry' : 'live')
  }

  const live = phase === 'live'
  const clearance = useDockClearance(live)

  /* 这一格的草稿归哪个键：对话是它的 id，入口那一格全局只有一个。 */
  const draftKey = endpoint

  /*
   * 发言就是那次转场，先于 send：这一刻起就是对话而非入口，不等任何一帧回来。
   *
   * `queued` 是人点名的「排队」（Ctrl/Cmd+Enter）：正在跑的时候它走 followUp ——
   * 这一轮跑完接着做，不打断。不点名时缺省按状态选（空闲开一轮、正在跑插话），
   * 那条判据在 useAssistantSession 里。
   */
  const submit = useCallback(
    ({ queued, ...message }: PromptInputMessage) => {
      setPhase('live')
      /* 正常发送不看回执：失败由横幅说。 */
      void assistant.send(message, queued === true ? 'followUp' : undefined)
    },
    [assistant.send],
  )

  /* 把手两个读者：外面写草稿（浏览器拾取），这层取回队列那句改。铺一条回调 ref 分给两边。 */
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

  /*
   * 换一层再投出去：撤回最后一条，用点名的层重投。
   *
   * 走的就是正常发送那条路（assistant.send 带 deliverAs），所以准入、投递、失败横幅
   * 全都与手打一句相同 —— 这一层不另开一条发送路径。交回有没有落地：队列条已经把这句
   * 话撤走了，重投没成时它得把正文还回输入框，不能凭空丢一句。
   */
  const redeliver = useCallback(
    async (text: string, deliverAs: PromptDelivery) =>
      (await assistant.send({ assets: [], configuration: [], skills: [], text }, deliverAs)) !== null,
    [assistant.send],
  )

  /* KAP 没有恢复同一轮的协议动作；这里发送一条可见新消息，不伪装成断流重建。 */
  const continueConversation = useCallback(() => {
    draft.current?.insertTextAndSubmit('Continue')
  }, [])

  /*
   * 输入框只挂一处，不属于任何一个相位：相位切换时它的 DOM 位置不变，草稿、附件、
   * 光标与焦点跨相位存活。prop 引用稳定，AssistantComposer 只随语义状态变化。
   */
  const dock = (
    <div className="assistant-surface__composer">
      {live && goal !== undefined ? <GoalBar goal={goal} onSelect={onSelectControl} /> : null}

      {failure === null || dismissed ? null : (
        <Banner
          {...(failed === undefined ? {} : { actions: [{ label: '取回文字', onClick: () => edit(failed.text) }] })}
          holdMs={FAILURE_HOLD_MS}
          key={failure}
          onDone={dismissFailure}
          text={failure}
          tone="error"
        />
      )}
      <PromptQueue onEdit={edit} onRedeliver={redeliver} queue={assistant.queue} />

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
      /*
       * 相位写到 DOM 上：样式表按相位分家（见 skin/surface.css），输入框只在会话态
       * 浮起 —— 这个布尔值不能只留在闭包里。
       */
      data-phase={live ? 'live' : 'entry'}
      data-restoring={assistant.isRestoring ? 'true' : undefined}
    >
      {/*
        线程标题栏：内容区固定的那一条（legacy 的 conversation-header，36px 高、地色底）。
        右端是 threadHeaderItems 的落点（review 的改动数、usage 的累计用量）。
        两个相位都在：legacy 的 showAssistantChrome 对 ai 入口表面同样为真。
      */}
      <div className="conversation-header" data-assistant-skin>
        <ThreadHeaderItems thread={thread} />
      </div>

      {/*
        正文列。结构与 legacy 的 conversation-body / conversation-canvas 逐字相同
        （workbench 的 workspace.tsx 就是这两层）：页头之下、占满剩余高度，
        雾层与相位内容都在画布里（输入框浮起时也以画布为包含块，位置与 legacy 一致）。
      */}
      {/* 几何常量（--conversation-todo-width 320px / --conversation-todo-gap 12px）写在正文列上：
          浮层本体与 @container 那条让位规则都从这一层继承（legacy 把同一个对象挂在
          conversation-body 上，见 conversation-todo-popover.tsx 的 CONVERSATION_TODO_LAYOUT_STYLE）。 */}
      <div className="conversation-body" style={CONVERSATION_TODO_LAYOUT_STYLE}>
        <div className="conversation-canvas">
          {/* 页头与转录之间的雾：legacy 的 conversation-veil，是正文盒顶部那一条。 */}
          <div className="conversation-veil" data-assistant-skin />

          {live ? (
            <TranscriptView
              dockClearance={clearance.value}
              isRestoring={assistant.isRestoring}
              onFork={onFork}
              sessionKey={assistant.key}
            />
          ) : (
            <div className="assistant-surface__entry">
              {/*
               * 入口提示：画在**入口区顶部**，吉祥物仍钉在输入框上方（legacy 的
               * `.assistant-surface__entry` 是 justify-content: flex-end）。
               *
               * 落点由产品负责人指定（2026-10-05 要「吉祥物上方」，2026-10-06 再要求
               * 「改到比较上面去」）：提示与吉祥物同属入口区这块版心，提示浮到顶、
               * 吉祥物不动。贡献点住在 ui-kernel（builtinPoints.entryNotices），
               * 所以这里不认识任何功能（03 页 §4.4）。
               */}
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
            任务与后台任务浮层（legacy 的 ConversationTodoPopover）：画在画布里、输入框之上，
            让位走 --assistant-surface-inline-end-clearance（见 conversation-todo-popover.css 的
            容器查询）。开合由页头那枚开关写 todoThread，这里只读 —— 同一件事只有一条写入路径。
          */}
          {todoThread === undefined ? null : (
            <TodoPopoverLayer
              endpoint={endpoint}
              goal={goal}
              onSelectControl={onSelectControl}
              todoThread={todoThread}
            />
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

          {/* 输入框下方的另一半自由空间。会话态没有它,所以输入框落在底部。 */}
          {live ? null : <div className="assistant-surface__ballast" />}
        </div>
      </div>
    </section>
  )
})
