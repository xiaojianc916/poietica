import './assistant.css'

import type { FeedRow } from '@poietica/agent'
import type {
  AgentSessionPort,
  PaletteEntry,
  SessionConfigControl,
  SessionUsage,
} from '@poietica/agent-contract'
import { memo, type Ref, useCallback, useMemo, useState } from 'react'
import { AssistantComposer } from '../composer/assistant-composer'
import { useDockClearance } from '../composer/dock-clearance'
import type { PermissionDockProps } from '../composer/permission-dock'
import type { PromptInputHandle } from '../composer/prompt-input'
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
  /** 这一格代表的对话。入口那一格在说话之前还不是任何一条。 */
  readonly endpoint: string | null
  /** 取得这一格即将成为的那条对话，在第一句话的时候。 */
  readonly identify?: (() => Promise<string | null>) | undefined
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
  /**
   * 分叉这条对话（整条带走）。只在最后一轮的操作区亮起：分叉整条带走，
   * 不选分叉点，所以从最后一轮分叉恰好就是整条。缺席 = 平台没有这个动作。
   */
  readonly onFork?: (() => void) | undefined
  /**
   * 这条对话所持有的会话给出的选择器。
   *
   * 它是被交进来的，不是在这里问出来的：选择器属于会话，会话属于对话，而
   * 对话由上层持有。这一层只负责把它画出来。
   */
  readonly controls: readonly SessionConfigControl[]
  readonly controlsFailure?: string | undefined
  readonly onSelectControl: (controlId: string, value: string) => void
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
  /** 对话里敲得出来的命令表，喂给输入框的斜杠菜单。 */
  readonly palette?: readonly PaletteEntry[] | undefined
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
  identify,
  onFork,
  onRetryControls,
  onSelectControl,
  onUserMessage,
  palette,
  session,
  usage,
  workspace,
}: AssistantSurfaceProps) {
  const assistant = useAssistantSession({ endpoint, identify, onUserMessage, session })

  /*
   * 连不上 agent 这件事，不在这一层写。
   *
   * 它在发生的地方写一次：threads-store 打开这条对话失败时，同一个 catch 里
   * 既记下控件那一格，也把经过交给转录（#transcripts?.failed）—— 于是它和帧流
   * 里的失败长同一个样子，都是那条横线。
   *
   * 这里此前还有一个 effect 把 controlsFailure 抄进转录，那是同一件事的第二次
   * 写入：一个可撤销的状态被写成了不可撤销的记录，重试成功之后那条线还在。
   */
  /* 输入框盖在转录上，所以转录要知道它有多高。理由见 dock-clearance。 */
  const dockRef = useDockClearance()

  /*
   * 待答的那道题。
   *
   * 「还在等的那一道必在本轮末尾」这条不变式的实现只有一处：选择器里的
   * pendingPermission。此前这里手抄了一份逐字相同的倒扫，依赖 rows ——
   * 而 rows 每帧都是新的，于是每个 token 都把本轮走一遍去找一个不动的东西。
   *
   * 现在它是一条订阅，交回的是转录里那个条目本身：在被答复之前恒是同一个
   * 引用，所以流式追加动不了这一层。提问不在这条通道上：它有自己的条目类型。
   */
  const blocked = useAssistantPending(assistant.key)

  /* 还在等的一共几个。审批带恒显示最早那一个，所以变的只有分母。 */
  const waiting = useAssistantPendingCount(assistant.key)

  /* 要批准的那件事本身，取自请求指向的那次调用。 */
  const call = useAssistantPendingCall(assistant.key)

  /* 待答的那一组题。协议自己的通道，答复与撤下直走会话端口，不经权限请求。 */
  const question = useAssistantQuestion(assistant.key)

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

    return { call, item: blocked, onResolve: assistant.resolvePermission, waiting }
  }, [assistant.resolvePermission, blocked, call, waiting])

  const [phase, setPhase] = useState<'entry' | 'live'>(() => (endpoint === null ? 'entry' : 'live'))

  /*
   * 相位是派生的，不是记住的。
   *
   * 惰性初始化只在挂载那一次算：标签页复用同一个实例、换一条对话进来时，
   * endpoint 已经变了而这里还停在上一相位 —— 入口的输入框长在对话里，或者反过来。
   * 渲染期直接改自己的 state 是 React 官方给「props 变了要复位 state」的写法，
   * 它在本次渲染内重跑，不会多出一帧闪烁，也不需要一个 effect。
   */
  const [seen, setSeen] = useState(endpoint)

  if (seen !== endpoint) {
    setSeen(endpoint)
    setPhase(endpoint === null ? 'entry' : 'live')
  }

  const live = phase === 'live'

  /*
   * 行怎么画，这一层不判。
   *
   * renderRow 没有依赖，恒是同一个引用 —— 那是虚拟列表的 prop，每帧换身份就
   * 等于每帧重渲全部可见行。
   */
  const renderRow = useCallback((row: FeedRow) => <TimelineRow row={row} />, [])

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
   * 输入框只挂一处。
   *
   * 两个相位各挂各的东西,但输入框不属于任何一个相位:它是这一层的孩子,相位切换
   * 时它的 DOM 位置一个字都不变。于是草稿、附件、光标与焦点跨相位存活。
   *
   * 它的每一个 prop 现在都是引用稳定的,而 AssistantComposer 是 memo 过的 ——
   * 一轮对话里它至多重渲两次(ready→streaming→ready),不是每个 token 一次。
   */
  const dock = (
    <div className="assistant-surface__composer">
      <AssistantComposer
        approval={approval}
        controls={controls}
        controlsFailure={controlsFailure}
        modes={assistant.modes}
        onAnswerQuestions={assistant.answerQuestions}
        onCancel={assistant.cancel}
        onDismissQuestions={assistant.dismissQuestions}
        onRetryControls={onRetryControls}
        onSelectControl={onSelectControl}
        onSetGoal={assistant.setGoal}
        onSubmit={submit}
        onToggleSwarm={assistant.toggleSwarm}
        palette={palette}
        question={question}
        ref={composer}
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

      {/*
        审批那一格现在长在输入框那张卡里，所以它的高度照样进了 useDockClearance
        的实测值（量的是整条带子），转录末端跟着让位 —— 没有第二条管线。
      */}
      <div className="assistant-surface__dock" ref={dockRef}>
        {dock}

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
