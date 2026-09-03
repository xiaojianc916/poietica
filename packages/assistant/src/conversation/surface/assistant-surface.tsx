import './assistant.css'

import type { AgentSessionPort, SessionConfigControl, SessionUsage } from '@poietica/conversation'
import { lazy, memo, type Ref, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { AssistantComposer } from '../composer/assistant-composer'
import { ComposerDraftKeyContext } from '../composer/composer-drafts'
import { useDockClearance } from '../composer/dock-clearance'
import type { PermissionDockProps } from '../composer/permission-dock'
import type { PromptInputHandle } from '../composer/prompt-input'
import { GoalBar } from '../goal/goal-bar'
import { EmotionBall, ENTRY_EMOTION_GROUPS } from '../mascot/emotion-ball'
import { useAgentToolkit } from '../session/agent-controls-context'
import type { AssistantSubmission } from '../session/use-assistant-session'
import { useAssistantInteractions, useAssistantSession } from '../session/use-assistant-session'
import { GitBranchPicker, type GitBranchPickerProps } from '../threads/git-branch-picker'
import { WorkspacePicker, type WorkspacePickerProps } from '../threads/workspace-picker'

const DeferredTranscriptView = lazy(() =>
  import('../timeline/transcript-view').then(({ TranscriptView }) => ({
    default: TranscriptView,
  })),
)

import { PromptQueue } from './prompt-queue'

export interface AssistantSurfaceProps {
  /** 这一格从出生起持有的稳定对话标识。 */
  readonly endpoint: string
  /** 是否尚未把这条对话写入平台。身份不参与这个生命周期判定。 */
  readonly isNew: boolean
  /** 第一条消息发送前，把已铸造的标识写入平台。 */
  readonly prepare?: (() => Promise<boolean>) | undefined
  /**
   * The session this surface talks to.
   *
   * Optional on purpose: without one the surface renders against an inert
   * stub, which is what fixtures and component work need. The desktop app
   * supplies the real IPC-backed port.
   */
  readonly session?: AgentSessionPort
  /**
   * What the user just said.
   *
   * The conversation list names a conversation from its first message,
   * and the surface does not own the list, so it reports it outwards.
   */
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
  /** 从某一轮分叉；dropTurns 是这一轮之后还有几轮。缺席 = 平台没有这个动作。 */
  readonly onFork?: ((dropTurns: number) => void) | undefined
  /**
   * 这条对话所持有的会话给出的选择器。
   *
   * 它是被交进来的，不是在这里问出来的：选择器属于会话，会话属于对话，而
   * 对话由上层持有。这一层只负责把它画出来。
   */
  readonly controls: readonly SessionConfigControl[]
  readonly controlsFailure?: string | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  /** 认领或改动失败之后重新问一次。 */
  readonly onRetryControls?: (() => void) | undefined
  /**
   * 新对话入口即将使用的工作目录。
   *
   * 已有对话没有这项；第一句话发出后 entry 相位结束，这一栏也随之卸载。
   */
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
  /** 工作目录的 git 分支上下文。不是仓库就是 undefined，整枚 chip 不渲染。 */
  readonly git?: GitBranchPickerProps | undefined
  /** 这条会话最近报的上下文用量。缺席（还没报、或是入口）就不画。 */
  readonly usage?: SessionUsage | undefined
  /**
   * 往输入框草稿里写字的那条 ref 通道（浏览器拾取是第一个真实调用方）。
   * 草稿的唯一所有者仍是 PromptInput；这一层只把通道铺过去，不碰内容。
   */
  readonly composer?: Ref<PromptInputHandle> | undefined
}

/*
 * 两个静止态,两棵树,一个输入框。
 *
 * 哪一种静止态生效，由一个显式的相位说了算，不由转录反推：转录是内容，落到
 * 底部是导航，把后者派生自前者，就等于让任何一帧内容变动都能搬动整块构成。
 * 会话态挂滚动区，入口态挂两块自由空间，挂载与卸载不可补间，中间态因此无法
 * 被表达。输入框始终是同一个 DOM 节点，两个相位共用它。
 *
 * 这一层也不再订阅转录。它订三样东西：这一轮忙不忙、历史取回来没有、有没有
 * 一道题在等答复 —— 三个都只在真的发生变化时才换值，所以模型吐字不会动它。
 * 转录归 TranscriptView，那是唯一需要跟着帧率走的地方。
 *
 * 这一层仍然不量任何几何。
 */
export const AssistantSurface = memo(function AssistantSurface({
  composer,
  controls,
  controlsFailure,
  endpoint,
  git,
  isNew,
  onFork,
  onRetryControls,
  onSelectControl,
  onUserMessage,
  prepare,
  session,
  usage,
  workspace,
}: AssistantSurfaceProps) {
  const assistant = useAssistantSession({ endpoint, onUserMessage, prepare, session })

  /* 名册属于这条连接，不属于这一格：入口态也画得出来。 */
  const { mcpServers, skills } = useAgentToolkit()

  /*
   * 连不上 agent 这件事，不在这一层写。
   *
   * 它在发生的地方写一次：threads-store 打开这条对话失败时，同一个 catch 里
   * 既记下控件那一格，也把经过交给转录（#transcripts?.failed）—— 于是它和帧流
   * 里的失败长同一个样子，都是那条横线。
   */
  const {
    permission: blocked,
    permissionCount: waiting,
    question,
  } = useAssistantInteractions(assistant.key)

  /*
   * 待答的那一次审批。
   *
   * 交出去的是那一格自己的整副入参，不是三个各走各的 prop：这一层不摆它，只是
   * 把它交给持有那张卡的人。引用只随「换了一个请求」或「分母变了」而变，所以流式
   * 追加动不了被 memo 过的 composer。
   */
  const approval = useMemo<PermissionDockProps | null>(() => {
    if (blocked === undefined) {
      return null
    }

    return { item: blocked, onResolve: assistant.resolvePermission, waiting }
  }, [assistant.resolvePermission, blocked, waiting])

  const [phase, setPhase] = useState<'entry' | 'live'>(() => (isNew ? 'entry' : 'live'))

  /*
   * 相位是派生的，不是记住的。
   *
   * 惰性初始化只在挂载那一次算：标签页复用同一个实例、换一条对话进来时，
   * endpoint 已经变了而这里还停在上一相位 —— 入口的输入框长在对话里，或者反过来。
   * 渲染期直接改自己的 state 是 React 官方给「props 变了要复位 state」的写法，
   * 它在本次渲染内重跑，不会多出一帧闪烁，也不需要一个 effect。
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
   * 发言就是那次转场。
   *
   * 它先于 send：这一刻起这一格是一段对话，不再是入口，而这件事不该等任何
   * 一帧回来才成立。
   */
  const submit = useCallback(
    (message: AssistantSubmission) => {
      setPhase('live')
      assistant.send(message)
    },
    [assistant.send],
  )

  /*
   * 输入框的把手有两个读者：外面拿它写草稿（浏览器拾取），这一层拿它把队列里
   * 那一句取回来改。所以铺一条回调 ref 分给两边，草稿的所有者仍是 PromptInput。
   */
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

  /* 队列里那一句回输入框。改完再发就回原位 —— 位置在出账簿手上，不在这里。 */
  const edit = useCallback((text: string) => {
    draft.current?.setText(text)
    draft.current?.focus()
  }, [])

  /* KAP 没有恢复同一轮的协议动作；这里发送一条可见新消息，不伪装成断流重建。 */
  const continueConversation = useCallback(() => {
    draft.current?.insertTextAndSubmit('请从刚才中断的地方继续。')
  }, [])

  /*
   * 输入框只挂一处。
   *
   * 两个相位各挂各的东西,但输入框不属于任何一个相位:它是这一层的孩子,相位切换
   * 时它的 DOM 位置一个字都不变。于是草稿、附件、光标与焦点跨相位存活。
   *
   * 它的 prop 引用稳定，AssistantComposer 只随语义状态变化，不随 token 重渲染。
   */
  const dock = (
    <div className="assistant-surface__composer">
      {live ? <GoalBar threadId={endpoint} /> : null}

      <PromptQueue onEdit={edit} outbox={assistant.outbox} />

      <AssistantComposer
        approval={approval}
        controls={controls}
        controlsFailure={controlsFailure}
        mcpServers={mcpServers}
        onAnswerQuestions={assistant.answerQuestions}
        onCancel={assistant.cancel}
        onContinue={continueConversation}
        onDismissQuestions={assistant.dismissQuestions}
        onRetryControls={onRetryControls}
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
       * 相位写到 DOM 上。
       *
       * 版式按相位分家本来就是这一层的范式（见 assistant.css：两个静止态，
       * 两棵树）。输入框只在会话态浮起 —— 入口态它是居中的，浮起来会掉到
       * 底部。样式表需要知道现在是哪一态，所以这个布尔值不能只留在闭包里。
       */
      data-phase={live ? 'live' : 'entry'}
      data-restoring={assistant.isRestoring ? 'true' : undefined}
    >
      {live ? (
        <Suspense fallback={<p className="p-4 text-xs opacity-50">正在加载对话…</p>}>
          <DeferredTranscriptView
            dockClearance={clearance.value}
            isRestoring={assistant.isRestoring}
            onFork={onFork}
            sessionKey={assistant.key}
          />
        </Suspense>
      ) : (
        <div className="assistant-surface__entry">
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

      <div className="assistant-surface__dock" ref={clearance.ref}>
        <ComposerDraftKeyContext value={draftKey}>{dock}</ComposerDraftKeyContext>

        {live || workspace === undefined ? null : (
          <div className="assistant-surface__context">
            <WorkspacePicker {...workspace} placement="composer" />

            {git === undefined ? null : <GitBranchPicker {...git} />}
          </div>
        )}
      </div>

      {/* 输入框下方的另一半自由空间。会话态没有它,所以输入框落在底部。 */}
      {live ? null : <div className="assistant-surface__ballast" />}
    </section>
  )
})
