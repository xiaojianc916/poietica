import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { MessageQueue, MessageQueueState } from '../../shared/model/message-queue'
import type { ApprovalAnswer } from '../../shared/model/permission'
import type { PlanAnswer } from '../../shared/model/plan'
import type { QuestionResponse } from '../../shared/model/question'
import type { ChatStatus } from '../../shared/model/run'
import type {
  AgentPromptHandle,
  AgentSessionPort,
  PromptAsset,
  PromptConfiguration,
  PromptDelivery,
  PromptSkill,
} from '../../shared/model/session'
import type { TurnMark } from '../../shared/model/thread'
import type { BackgroundTaskItem, SubagentItem, TimelineState, TodoItem } from '../../shared/timeline/timeline-contract'
import type { PendingInteractions } from '../timeline-queries'
import { activeScope, currentTodos, pendingInteractions } from '../timeline-queries'
import type { PreparedThread, Transcript } from './transcript-store'
import { canCancel, deliveryUnknown } from './transcript-store'
import { useTranscripts } from './transcripts-context'
import { VIEW_FRAMES } from './view-frames'

/* 每个消费者只订阅最窄的稳定投影；完整 timeline 仅供 TranscriptView。 */
export interface AssistantSubmission {
  readonly text: string
  /**
   * 这一句带的图片已经在原生的交付注册表里。不是 File：字节在用户放手的那一刻就入了库，所以发送这条路上再没有要读、要编码、要等的东西。
   */
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
}

export interface AssistantSessionOptions {
  readonly endpoint: string
  /** 铸号：入口那一格此刻还没有号（`''`），号由 `threads.create` 铸出来，连同它的端口一起交回。 */
  readonly prepare?: (() => Promise<PreparedThread | null>) | undefined
  /** 交付，而不是被取走：会话列表靠第一句话给对话命名，而列表不归这个 hook 持有。 */
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
  readonly session?: AgentSessionPort | undefined
}

export interface AssistantSession {
  readonly key: string
  readonly status: ChatStatus
  /**
   * `deliverAs` 缺省时按这一刻的状态选：空闲开一轮，正在跑就插话（omp 自己的 TUI 就是这一条）。交回回执（没送出去就是 null）：
   * 正常发送不看它（失败由横幅说）；而**撤回再重投**那条路必须看，重投没成时它得把正文还回去。
   */
  readonly send: (submission: AssistantSubmission, deliverAs?: PromptDelivery) => Promise<AgentPromptHandle | null>
  readonly cancel: () => void
  readonly resolvePermission: (requestId: string, answer: ApprovalAnswer) => void
  readonly resolvePlan: (requestId: string, answer: PlanAnswer) => void
  readonly answerQuestions: (response: QuestionResponse) => Promise<void>
  readonly dismissQuestions: (questionId: string) => Promise<void>
  readonly queue: MessageQueue
  readonly isRestoring: boolean
  readonly notice: string | null
  readonly submissions: Transcript['submissions']
  /**
   * 与 `submissions` 分开：那一份是**本机**的乐观记录，而排队 / 插话的失败是 Core 库里的事实 —— 重开界面、Core 重启之后本机什么都不记得。
   * 判据取**最后一条**：人重新发了一句之后，旧的那条失败不该再顶在横幅上。
   */
  readonly failedSubmissionText: string | null
}

/* 一条订阅，一个投影。project 必须是模块级函数：它进 getSnapshot 的依赖数组，内联箭头等于每次渲染换一个 getSnapshot。 */
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

  /* 事实的通知是同步的，视图的通知按帧合并：一帧最多渲染一次、窗口不可见时不渲染；退订时把还没等到帧的那一次一并撤掉。 */
  const subscribe = useCallback(
    (onChange: () => void) => {
      const off = transcripts.subscribe(key, () => VIEW_FRAMES.schedule(onChange))
      return () => {
        off()
        VIEW_FRAMES.forget(onChange)
      }
    },
    [transcripts, key],
  )

  return useSyncExternalStore(subscribe, read)
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
 * 投递结果不明时状态仍是 `error`（「刚才那一下没成」是事实），但那一轮**可能还在跑** —— 回执正是没回来的那一样。
 * 停止键只认在飞的那几档，所以这里给它一档在飞：否则那一刻键是灰的，而人正需要按下去。
 */
const readStatus = (transcript: Transcript): ChatStatus =>
  deliveryUnknown(transcript) ? 'submitted' : toChatStatus(transcript.status)

const readRestoring = (transcript: Transcript): boolean => transcript.restoring
const readNotice = (transcript: Transcript): string | null =>
  transcript.operation.kind === 'failed' ? transcript.operation.message : null
const readSubmissions = (transcript: Transcript): Transcript['submissions'] => transcript.submissions

/**
 * **最晚提交**的那一行的正文，且它必须是 failed；否则 null。只看最晚一条：往前扫会把人已经重发过的旧失败一遍遍翻出来。
 *
 * 按 `createdAt` 取、不按数组末尾取（审查 R-20-1）：数组顺序是「到达顺序」—— 快照、通知、retry 的回执交错到达，
 * 末尾不一定是最晚的那一句。并列时取靠后者（同一毫秒的两句，后到的那条更新）。
 */
export const readFailedSubmissionText = (transcript: Transcript): string | null => {
  let latest: Transcript['submissionRows'][number] | undefined
  for (const row of transcript.submissionRows) {
    if (latest === undefined || row.createdAt >= latest.createdAt) latest = row
  }
  return latest !== undefined && latest.status === 'failed' ? latest.text : null
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

const readHasEarlier = (transcript: Transcript): boolean => transcript.earlier !== null

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
  /* 在效果里做而不是渲染里做 —— 它会发命令。入口那一格（`''`）没有号，跳过。 */
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
       * 排队（`followUp`）是流式下的缺省，不是插话：插话会打断模型手上那一步，而人多半只是想「等它做完再说」。
       * 判据取的是**在飞**而不是 `running`：`submitted`（回执还没回来）也是一轮正在起。
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

export function useAssistantTodos(key: string): readonly TodoItem[] {
  return useSlice(key, readTodos)
}

export function useAssistantBackgroundTasks(key: string): readonly BackgroundTaskItem[] {
  return useSlice(key, readBackgroundTasks)
}

export function useAssistantSubagents(key: string): readonly SubagentItem[] {
  return useSlice(key, readSubagents)
}

export function useAssistantHasEarlier(key: string): boolean {
  return useSlice(key, readHasEarlier)
}

export function useAssistantOutline(key: string): readonly TurnMark[] {
  return useSlice(key, readOutline)
}

export function useAssistantRevealTarget(key: string): string | null {
  return useSlice(key, readRevealTarget)
}

export function useAssistantInteractions(key: string): PendingInteractions {
  return useSlice(key, readPendingInteractions, samePendingInteractions)
}
