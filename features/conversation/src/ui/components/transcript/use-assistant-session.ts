import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ApprovalAnswer } from '../../agent/permission'
import type { PlanAnswer } from '../../agent/plan'
import type { QuestionResponse } from '../../agent/question'
import type { ChatStatus } from '../../agent/run'
import type {
  AgentPromptHandle,
  AgentSessionPort,
  PromptAsset,
  PromptConfiguration,
  PromptDelivery,
  PromptSkill,
} from '../../agent/session'
import type { TurnMark } from '../../agent/thread'
import type { MessageQueue, MessageQueueState } from '../../interjection/message-queue'
import type { BackgroundTaskItem, SubagentItem, TimelineState, TodoItem } from '../../timeline/timeline-contract'
import type { PendingInteractions } from '../../timeline/timeline-queries'
import { activeScope, currentTodos, pendingInteractions } from '../../timeline/timeline-queries'
import type { PreparedThread, Transcript } from '../../transcript/transcript-store'
import { canCancel, deliveryUnknown } from '../../transcript/transcript-store'
import { useTranscripts } from './transcripts-context'

/* 每个消费者只订阅最窄的稳定投影；完整 timeline 仅供 TranscriptView。
   其他投影返回字面量或 reducer 持有的引用，流式帧不会重渲染无关 UI。 */
export interface AssistantSubmission {
  readonly text: string
  /**
   * 这一句带的图片，已经在原生的交付注册表里。
   *
   * 不是 File：字节在用户放手的那一刻就入了库（拖放与文件对话框交路径，剪贴板交
   * 一次 base64），所以发送这条路上再没有任何要读、要编码、要等的东西。
   */
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
}

export interface AssistantSessionOptions {
  /** Stable conversation identity, minted before this surface mounts. */
  readonly endpoint: string
  /**
   * 铸号：入口那一格的键此刻还没有号（`''`），号由 `threads.create` 铸出来，
   * 连同它的端口一起交回。线程页没有这一项 —— 号在挂载前就有了。
   */
  readonly prepare?: (() => Promise<PreparedThread | null>) | undefined
  /**
   * What the user just said, before the agent is asked anything.
   *
   * The conversation list names a conversation from its first message,
   * and the list is not this hook to keep, so the fact is handed out
   * rather than reached for.
   */
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
  readonly session?: AgentSessionPort | undefined
}

export interface AssistantSession {
  /** 这一格现在的键：真对话 id，或入口那一格的草稿键。 */
  readonly key: string
  readonly status: ChatStatus
  /**
   * 发一句话。
   *
   * `deliverAs` 缺省时按这一刻的状态选：空闲开一轮，正在跑就插话（omp 自己的 TUI
   * 就是这一条：流式中回车 = steer）。显式传就是调用方点名要那一层。
   *
   * 交回回执（没送出去就是 null）：正常发送不看它 —— 失败由横幅说；而**撤回再重投**
   * 那条路必须看，因为撤回已经把那句话从队列里拿走了，重投没成时它得把正文还回去。
   */
  readonly send: (submission: AssistantSubmission, deliverAs?: PromptDelivery) => Promise<AgentPromptHandle | null>
  readonly cancel: () => void
  readonly resolvePermission: (requestId: string, answer: ApprovalAnswer) => void
  /** 答一张计划卡片（04 页 §3.12 第 5 支）。 */
  readonly resolvePlan: (requestId: string, answer: PlanAnswer) => void
  /** 答掉一整组题。答复形状就是协议自己的 QuestionResponse，不经权限请求。 */
  readonly answerQuestions: (response: QuestionResponse) => Promise<void>
  /** 撤下一整组题。 */
  readonly dismissQuestions: (questionId: string) => Promise<void>
  /** agent 那条待发队列的看法：两层正文、撤回与队列模式。 */
  readonly queue: MessageQueue
  /** True while a conversation is still being fetched. */
  readonly isRestoring: boolean
  readonly notice: string | null
  readonly submissions: Transcript['submissions']
  /**
   * 最近一条提交**没送到**时的正文（R-08-5）。
   *
   * 与 `submissions` 分开：那一份是**本机**的乐观记录（只覆盖界面自己发起的那一次提交），
   * 而排队 / 插话的失败是 Core 库里的事实 —— 重开界面、Core 重启之后本机什么都不记得，
   * 只有库里那一条 failed 还在。判据取**最后一条**：人重新发了一句之后，旧的那条失败
   * 不该再顶在横幅上（那是已经翻篇的一件事）。
   */
  readonly failedSubmissionText: string | null
}

/*
 * 一条订阅，一个投影。
 *
 * project 必须是模块级函数：它进 getSnapshot 的依赖数组，写成内联箭头就等于
 * 每次渲染换一个 getSnapshot，React 会当作快照可能变了。
 */
type SliceEquality<TValue> = (left: TValue, right: TValue) => boolean

const sameValue = <TValue>(left: TValue, right: TValue): boolean => Object.is(left, right)

function useSlice<TValue>(
  key: string,
  project: (transcript: Transcript) => TValue,
  equal: SliceEquality<TValue> = sameValue,
): TValue {
  const transcripts = useTranscripts()
  const held = useRef<{ readonly key: string; readonly value: TValue } | null>(null)
  const read = useCallback(() => {
    const next = project(transcripts.read(key))
    const previous = held.current

    if (previous !== null && previous.key === key && equal(previous.value, next)) {
      return previous.value
    }

    held.current = { key, value: next }
    return next
  }, [equal, key, project, transcripts])

  return useSyncExternalStore(
    useCallback((onChange: () => void) => transcripts.subscribe(key, onChange), [transcripts, key]),
    read,
  )
}

/* 纯 switch，返回字符串字面量：依赖数组的分配与比较比它本身贵。 */
function toChatStatus(status: TimelineState['status']): ChatStatus {
  switch (status) {
    case 'submitted':
      return 'submitted'
    case 'cancelling':
      return 'cancelling'
    case 'cancelled':
      return 'interrupted'
    case 'running':
    case 'awaiting_permission':
    case 'awaiting_plan':
    case 'awaiting_question':
      return 'streaming'
    case 'failed':
      return 'error'
    default:
      return 'ready'
  }
}

/*
 * 投递结果不明时状态仍是 `error`（「刚才那一下没成」是事实），但那一轮**可能还在跑** ——
 * 回执正是没回来的那一样。停止键只认在飞的那几档（PromptInputSubmit 的 canCancel），
 * 所以这里给它一档在飞：否则截图里那一刻键是灰的，而人正需要按下去。
 */
const readStatus = (transcript: Transcript): ChatStatus =>
  deliveryUnknown(transcript) ? 'submitted' : toChatStatus(transcript.status)

const readRestoring = (transcript: Transcript): boolean => transcript.restoring
const readNotice = (transcript: Transcript): string | null =>
  transcript.operation.kind === 'failed' ? transcript.operation.message : null
const readSubmissions = (transcript: Transcript): Transcript['submissions'] => transcript.submissions

/**
 * 最后一条提交的正文，且它必须是 failed；否则 null。
 *
 * 只看最后一条：Core 的提交行全部留着（重试要按号找回那一行、附件引用还挂在它身上），
 * 往前扫会把人已经重发过的旧失败一遍遍翻出来。
 */
export const readFailedSubmissionText = (transcript: Transcript): string | null => {
  const last = transcript.submissionRows[transcript.submissionRows.length - 1]
  return last !== undefined && last.status === 'failed' ? last.text : null
}

const readTimeline = (transcript: Transcript): TimelineState => transcript.timeline
const EMPTY_LIST: readonly TodoItem[] = []
const readTodos = (transcript: Transcript): readonly TodoItem[] => currentTodos(transcript.timeline) ?? EMPTY_LIST

const EMPTY_BACKGROUND_TASKS: readonly BackgroundTaskItem[] = []
const readBackgroundTasks = (transcript: Transcript): readonly BackgroundTaskItem[] =>
  transcript.timeline.backgroundTasks.length === 0 ? EMPTY_BACKGROUND_TASKS : transcript.timeline.backgroundTasks

const EMPTY_SUBAGENTS: readonly SubagentItem[] = []
const readSubagents = (transcript: Transcript): readonly SubagentItem[] =>
  transcript.timeline.subagents.length === 0 ? EMPTY_SUBAGENTS : transcript.timeline.subagents

/* 上面还有没有更早的一页。布尔，所以前插与流式追加都叫不醒订阅者。 */
const readHasEarlier = (transcript: Transcript): boolean => transcript.earlier !== null

/* 整本目录。引用只在库里那张表变过之后才换。 */
const readOutline = (transcript: Transcript): readonly TurnMark[] => transcript.outline

const readRevealTarget = (transcript: Transcript): string | null => transcript.revealing

const readPendingInteractions = (transcript: Transcript): PendingInteractions =>
  pendingInteractions(activeScope(transcript.timeline))

const samePendingInteractions: SliceEquality<PendingInteractions> = (left, right) =>
  left.permission === right.permission &&
  left.permissionCount === right.permissionCount &&
  left.plan === right.plan &&
  left.question === right.question
export function useAssistantSession({
  endpoint: key,
  onUserMessage,
  prepare,
  session,
}: AssistantSessionOptions): AssistantSession {
  const transcripts = useTranscripts()
  const queue = transcripts.queue(key)
  const running = useSlice(key, readStatus)
  const isRestoring = useSlice(key, readRestoring)
  const notice = useSlice(key, readNotice)
  const submissions = useSlice(key, readSubmissions)
  const failedSubmissionText = useSlice(key, readFailedSubmissionText)
  /*
   * 打开一条已经存在的对话：接上端口、把这一格整读一遍。
   *
   * 效果里做而不是渲染里做 —— 它会发命令。入口那一格（`''`）没有号，跳过：
   * 它的端口由 `prepare` 在第一句话时铸出来。
   */
  useEffect(() => {
    if (key !== '') {
      transcripts.open(key)
    }
  }, [key, transcripts])
  const queued = useSyncExternalStore(
    queue.subscribe,
    useCallback((): number => {
      const state: MessageQueueState = queue.read()
      return state.steering.length + state.followUp.length
    }, [queue]),
  )
  const send = useCallback(
    (submission: AssistantSubmission, deliverAs?: PromptDelivery) => {
      /*
       * 缺省按这一刻的状态选层：空闲开一轮（那才是「一句话」），**正在跑就排队**。
       *
       * 排队（`followUp`）是流式下的缺省，不是插话：插话会打断模型手上那一步，而人多半
       * 只是想「等它做完再说」。要打断得自己点名（队列条上那枚「插话」）。
       *
       * 判据取的是**在飞**而不是 `running`：`submitted` 那一档（回执还没回来）也是一轮
       * 正在起，拿不准时排队不会丢话 —— 上游对排队永远不抛忙碌错。
       */
      const delivery: PromptDelivery = deliverAs ?? (canCancel(transcripts.read(key)) ? 'followUp' : 'turn')
      return transcripts.send({
        ...submission,
        deliverAs: delivery,
        onUserMessage,
        ...(session === undefined ? {} : { port: session }),
        prepare,
        threadId: key,
      })
    },
    [key, onUserMessage, prepare, session, transcripts],
  )
  const cancel = useCallback(() => transcripts.cancel(key), [key, transcripts])
  const resolvePermission = useCallback(
    (requestId: string, answer: ApprovalAnswer) => {
      transcripts.resolvePermission(key, requestId, answer)
    },
    [key, transcripts],
  )
  const resolvePlan = useCallback(
    (requestId: string, answer: PlanAnswer) => {
      transcripts.resolvePlan(key, requestId, answer)
    },
    [key, transcripts],
  )
  const answerQuestions = useCallback(
    (response: QuestionResponse) => transcripts.answerQuestions(key, response),
    [key, transcripts],
  )
  const dismissQuestions = useCallback(
    (questionId: string) => transcripts.dismissQuestions(key, questionId),
    [key, transcripts],
  )
  return {
    key,
    status: queued > 0 ? 'queued' : running,
    send,
    cancel,
    resolvePermission,
    resolvePlan,
    answerQuestions,
    dismissQuestions,
    queue,
    isRestoring,
    notice,
    submissions,
    failedSubmissionText,
  }
}

/** 完整 timeline 只供转录视图；这是唯一按帧重渲染的订阅。 */
export function useAssistantTimeline(key: string): TimelineState {
  return useSlice(key, readTimeline)
}

/** 当前工具调用携带的整份任务清单；失败时回退到上一份成功清单。 */
export function useAssistantTodos(key: string): readonly TodoItem[] {
  return useSlice(key, readTodos)
}

/** 由 agent 生命周期帧投影出的后台任务（shell/工具作业）。 */
export function useAssistantBackgroundTasks(key: string): readonly BackgroundTaskItem[] {
  return useSlice(key, readBackgroundTasks)
}

/** 由 agent 生命周期帧投影出的子代理；「智能体」那一节画它们。 */
export function useAssistantSubagents(key: string): readonly SubagentItem[] {
  return useSlice(key, readSubagents)
}

/** 这条对话上面还有没有更早的一页。 */
export function useAssistantHasEarlier(key: string): boolean {
  return useSlice(key, readHasEarlier)
}

/** 这条对话的整本目录，一轮一行。 */
export function useAssistantOutline(key: string): readonly TurnMark[] {
  return useSlice(key, readOutline)
}

/** 目录跳转正在补载的轮次。 */
export function useAssistantRevealTarget(key: string): string | null {
  return useSlice(key, readRevealTarget)
}

/** 输入区的待答状态：一个稳定快照、一条订阅、一次领域扫描。 */
export function useAssistantInteractions(key: string): PendingInteractions {
  return useSlice(key, readPendingInteractions, samePendingInteractions)
}
