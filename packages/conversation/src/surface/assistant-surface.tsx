import './skin/surface.css'

import { Banner } from '@poietica/design-system'
import { memo, type Ref, useCallback, useMemo, useRef, useState } from 'react'
import type { SessionConfigControl } from '../agent/config'
import type { AgentSessionPort } from '../agent/session'
import type { SessionUsage } from '../agent/usage'
import type { PromptInputMessage } from '../composer/prompt'
import { AssistantComposer } from './composer/assistant-composer'
import { ComposerNotice } from './composer/composer-notice'
import { useDockClearance } from './composer/dock-clearance'
import { ComposerDraftKeyContext } from './composer/drafts-context'
import type { PermissionDockProps } from './composer/permission-dock'
import type { PromptInputHandle } from './composer/prompt-input'
import { SwarmToggle } from './composer/swarm-toggle'
import { useAgentToolkit } from './configuration/agent-controls-context'
import { GoalBar } from './goal/goal-bar'
import { EmotionBall, ENTRY_EMOTION_GROUPS } from './mascot/emotion-ball'
import { PromptQueue } from './prompt-queue'
import { GitBranchPicker, type GitBranchPickerProps } from './threads/git-branch-picker'
import { WorkspacePicker, type WorkspacePickerProps } from './threads/workspace-picker'
import { TranscriptView } from './timeline/transcript-view'
import { useAssistantInteractions, useAssistantSession } from './transcript/use-assistant-session'

/* 连不上 agent 时输入区上沿那一句；原文（controlsFailure）只做 title。 */
const DISCONNECTED = '没连上 agent，点击重试'

export interface AssistantSurfaceProps {
  /** 这一格从出生起持有的稳定对话标识。 */
  readonly endpoint: string
  /** 是否尚未把这条对话写入平台。身份不参与这个生命周期判定。 */
  readonly isNew: boolean
  /** 第一条消息发送前，把已铸造的标识写入平台。 */
  readonly prepare?: (() => Promise<boolean>) | undefined
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
  /** 工作目录的 git 分支上下文。不是仓库就是 undefined，整枚 chip 不渲染。 */
  readonly git?: GitBranchPickerProps | undefined
  /** 这条会话最近报的上下文用量。缺席（还没报、或是入口）就不画。 */
  readonly usage?: SessionUsage | undefined
  /** 草稿的 ref 通道（浏览器拾取是第一个调用方）。所有者仍是 PromptInput，这层只铺通道不碰内容。 */
  readonly composer?: Ref<PromptInputHandle> | undefined
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
   * 连不上 agent 不在这一层写：threads-store 打开对话失败的同一个 catch 里既记控件格，
   * 也把经过交给转录（#transcripts?.failed）—— 它和帧流里的失败长同一个样子。
   */
  const {
    permission: blocked,
    permissionCount: waiting,
    question,
  } = useAssistantInteractions(assistant.key)

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
      assistant.send(message, queued === true ? 'followUp' : undefined)
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
      {live ? <GoalBar threadId={endpoint} /> : null}

      {failure === null || dismissed ? null : (
        <Banner
          {...(failed === undefined
            ? {}
            : { actions: [{ label: '取回文字', onClick: () => edit(failed.text) }] })}
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
      {live ? (
        <TranscriptView
          dockClearance={clearance.value}
          isRestoring={assistant.isRestoring}
          onFork={onFork}
          sessionKey={assistant.key}
        />
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
          <div className="composer-context">
            <WorkspacePicker {...workspace} placement="composer" />

            {git === undefined ? null : <GitBranchPicker {...git} />}

            {/* 最右端：左边两枚说「在哪跑」，它说「这一句怎么跑」。 */}
            <SwarmToggle controls={controls} onSelect={onSelectControl} pending={controlsPending} />
          </div>
        )}
      </div>

      {/* 输入框下方的另一半自由空间。会话态没有它,所以输入框落在底部。 */}
      {live ? null : <div className="assistant-surface__ballast" />}
    </section>
  )
})
