import { AppError, createId, InvariantError, invariant, SystemErrorCode } from '@poietica/foundation'
import type { AgentTranscriptSnapshot } from '@poietica/transcript'
import type { SubmissionView } from '../../../contract'
import { conversationErrors } from '../../../contract'
import { describeFailure } from '../../failure'
import type { DialogAnswer } from '../../shared/model/dialog'
import { MessageQueue } from '../../shared/model/message-queue'
import type { ApprovalAnswer } from '../../shared/model/permission'
import type { PlanAnswer } from '../../shared/model/plan'
import type { QuestionResponse } from '../../shared/model/question'
import type { RunStatus } from '../../shared/model/run'
import type {
  AgentPromptHandle,
  AgentSessionPort,
  DeliveryModePatch,
  DroppedPrompt,
  PromptAsset,
  PromptConfiguration,
  PromptDelivery,
  PromptSkill,
  QueuedMessages,
  RunFailed,
} from '../../shared/model/session'
import type { TurnMark } from '../../shared/model/thread'
import type { TranscriptPage, TranscriptSignal } from '../../shared/model/transcript'
import {
  createTimelineState,
  fileMetaLabel,
  type MessageFile,
  type MessageImage,
  type TimelineItem,
  type TimelineState,
  type TurnOutcome,
} from '../../shared/timeline/timeline-contract'
import { delegateAddress, delegateKey } from '../delegate-channel'
import { clientTurnIdsOf, selectIsBusy } from '../timeline-queries'
import {
  createProjectionMemo,
  knownPromptIds,
  outlineOf,
  type ProjectionMemo,
  projectTranscript,
  promptOutcome,
} from './transcript-projector'
import { TranscriptReplica } from './transcript-replica'
import type { TranscriptSink } from './transcript-sink'

export interface PendingSubmission {
  readonly id: number
  readonly text: string
  readonly submittedAt: number
  readonly phase: 'submitting' | 'accepted' | 'failed'
  readonly promptId: string | null
}

type ConversationOperation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'cancelling' }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly blocks: boolean
      /** 这一句离开了本机而回执没回来：那一轮**可能还在跑**。只有它需要停止键，不能由错误文案反推。 */
      readonly indeterminate: boolean
    }

/** 投递结果不明：跑没跑起来不知道。不改状态（`failed` 仍对），只让停止键认「可能还有一轮」。 */
export function deliveryUnknown(transcript: Transcript): boolean {
  return transcript.operation.kind === 'failed' && transcript.operation.indeterminate
}

export function canCancel(transcript: Transcript): boolean {
  return selectIsBusy(transcript.timeline) || deliveryUnknown(transcript)
}

/**
 * 本机把还在跑的那一轮收掉：Core 中途没了，那一轮**再也不会有帧**了。
 *
 * 收尾（`run.settled`）与**终局**（`outcome`）必须一起写。只收尾不写终局时，封条会落到
 * 「缺终局就按正常答完算」那一支 —— 屏幕把死在半路的一轮报成「已完成」，还让它可折。
 * DSH 对同一种情形（turn/end 的 reason 是 `interrupted`，即进程先退出了）报的是「已停止」；
 * 本仓的终局那一格里，`aborted` 就是「已停止」。
 *
 * 其余格（items、usage、spans）是 agent 说过的事实，无权改写；`outcome` 也只补**缺的那一格**，
 * agent 已经报过终局时不改口。
 */
function settleActiveRun(timeline: TimelineState, outcome: TurnOutcome | undefined): TimelineState {
  const run = timeline.active.run

  if (run === undefined || run.settled) {
    return timeline
  }

  const settled = outcome === undefined || timeline.active.outcome !== undefined ? {} : { outcome }

  return {
    ...timeline,
    status: 'failed',
    active: { ...timeline.active, run: { ...run, settled: true }, ...settled },
  }
}

function activityOf(transcript: Transcript): RunStatus {
  const busy = selectIsBusy(transcript.timeline)

  if (busy && transcript.operation.kind === 'cancelling') {
    return 'cancelling'
  }
  if (busy) {
    return transcript.timeline.status
  }
  if (transcript.submissions.some((entry) => entry.phase !== 'failed')) {
    return 'submitted'
  }
  if (transcript.operation.kind === 'failed' && transcript.operation.blocks) {
    return 'failed'
  }
  return transcript.timeline.status
}

export interface Transcript {
  readonly status: RunStatus
  readonly operation: ConversationOperation
  readonly submissions: readonly PendingSubmission[]
  /** Core 存下并推回的真实提交记录；真实 turn 画得出来之前，时间线画的就是这一份。 */
  readonly submissionRows: readonly SubmissionView[]
  readonly promptId: string | null
  readonly timeline: TimelineState
  readonly restoring: boolean
  readonly loaded: boolean
  readonly owned: boolean
  readonly earlier: string | null
  readonly outline: readonly TurnMark[]
  readonly reading: boolean
  readonly revealing: string | null
}
interface SendOptions {
  readonly threadId: string
  readonly text: string
  readonly deliverAs: PromptDelivery
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
  /* 号由 Core 铸，键只能在 prepare 之后才知道，**先后顺序不能反**；交回 null 表示这一刻开不出对话。 */
  readonly prepare?: (() => Promise<PreparedThread | null>) | undefined
  /** 身份由 ui/session-registry.ts 单点持有；第一句话之前不存在，随 `prepare` 到手。 */
  readonly port?: AgentSessionPort | undefined
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
}
const MAIN_AGENT_ID = 'main'
const PENDING_SIGNAL_LIMIT = 64

/** 端口按对话建、订阅随它生灭 —— 一次连接一条会话，正是 `threadId` 的粒度。 */
interface HeldSession {
  readonly port: AgentSessionPort
  readonly offs: readonly (() => void)[]
}

/** `prepare` 的产物：端口按号建，而号刚铸出来，所以键与端口一起交回。 */
export interface PreparedThread {
  readonly key: string
  readonly port: AgentSessionPort
}

/** 提交行在时间线里的条目 id 前缀：换真实 turn 时靠它把上一份剔掉。 */
const SUBMISSION_ITEM_PREFIX = 'submission:'

/** 提交行带的附件与真实 turn 投影出来的同形：换的那一帧气泡上的图与文件记号不闪。 */
function rowAttachments(row: SubmissionView): { images?: MessageImage[]; files?: MessageFile[] } {
  if (row.attachments.length === 0) {
    return {}
  }
  const images: MessageImage[] = []
  const files: MessageFile[] = []
  for (const attachment of row.attachments) {
    if (attachment.kind === 'image') {
      images.push(attachment.previewUrl === null ? { pending: true } : { url: attachment.previewUrl })
    } else {
      files.push({ name: attachment.name, meta: fileMetaLabel(attachment.name, attachment.size) })
    }
  }
  return { ...(images.length === 0 ? {} : { images }), ...(files.length === 0 ? {} : { files }) }
}

/** 只画 `deliverAs === 'turn'` 且还没被真实 turn 换掉的。例外是**失败的插话 / 排队**（R-08-5）：不画就等于那句话无声无息地消失。 */
function withSubmissionRows(next: Transcript, seen: ReadonlySet<string>): Transcript {
  /* 先剔上一轮贴进来的再贴当前应有的：`#put` 会被调很多次，不先剔就越贴越多（实测：一次发送出现 3~7 条一样的用户气泡）。 */
  const stripped = next.timeline.active.items.some((item) => item.id.startsWith(SUBMISSION_ITEM_PREFIX))
    ? {
        ...next.timeline,
        active: {
          ...next.timeline.active,
          items: next.timeline.active.items.filter((item) => !item.id.startsWith(SUBMISSION_ITEM_PREFIX)),
        },
      }
    : next.timeline
  const rows = next.submissionRows.filter((row) =>
    row.deliverAs === 'turn' ? row.status !== 'queued' : row.status === 'failed',
  )
  if (rows.length === 0) {
    return stripped === next.timeline ? next : { ...next, timeline: stripped }
  }
  /* 「真轮已经换过这条提交」的判据是 `seen`：剔掉的提交条目不带号，所以不必再扫一遍整条时间线。 */
  const pending = rows.filter((row) => !seen.has(row.clientTurnId))
  if (pending.length === 0) {
    return { ...next, timeline: stripped }
  }
  const items: TimelineItem[] = pending.map((row) => ({
    type: 'user_message',
    id: `${SUBMISSION_ITEM_PREFIX}${row.clientTurnId}`,
    turn: stripped.active.turn,
    at: row.createdAt,
    text: row.text,
    ...(row.status === 'failed' ? { undelivered: true } : {}),
    ...(row.skills.length === 0 ? {} : { skills: row.skills }),
    ...rowAttachments(row),
  }))
  /* 插在本轮开头，与真实投影里把用户消息放最前同形 —— 换的那一帧 DOM 才不跳。 */
  return {
    ...next,
    timeline: {
      ...stripped,
      active: { ...stripped.active, items: [...items, ...stripped.active.items] },
    },
  }
}

/** 由组装点（ui/index.tsx）注入 —— store 不 import 自己的 api。身份由 ui/session-registry.ts 单点持有：同一条对话永远交回同一个对象。 */
export type SessionPortFactory = (threadId: string) => AgentSessionPort

const EMPTY: Transcript = {
  timeline: createTimelineState(),
  status: 'idle',
  operation: { kind: 'ready' },
  submissions: [],
  submissionRows: [],
  promptId: null,
  restoring: false,
  loaded: false,
  owned: false,
  earlier: null,
  outline: [],
  reading: false,
  revealing: null,
}
const channelKey = (threadId: string, agentId: string): string =>
  agentId === MAIN_AGENT_ID ? threadId : delegateKey(threadId, agentId)
const addressOf = (key: string): { readonly conversation: string; readonly agentId: string } =>
  delegateAddress(key) ?? { conversation: key, agentId: MAIN_AGENT_ID }

/** 还没在快照里露面的本机提交（按 agent 的 promptId 收口）；一条都没有时不建号表，那要扫一遍快照全部轮次。 */
function remainingSubmissions(
  submissions: readonly PendingSubmission[],
  snapshot: AgentTranscriptSnapshot,
): readonly PendingSubmission[] {
  if (submissions.every((entry) => entry.promptId === null)) {
    return submissions
  }
  const known = knownPromptIds(snapshot)
  const remaining = submissions.filter((entry) => entry.promptId === null || !known.has(entry.promptId))
  return remaining.length === submissions.length ? submissions : remaining
}

export class TranscriptStore implements TranscriptSink {
  readonly #queues = new Map<string, MessageQueue>()
  /* 每份队列此刻归哪条对话。键关在闭包里会一直拿入口那格的 `''` 找端口，点了没反应（真机故障，见 transcript-store.test.ts「入口页开的对话」）。 */
  readonly #queueHomes = new WeakMap<MessageQueue, { key: string }>()
  readonly #held = new Map<string, Transcript>()
  readonly #owners = new Map<string, TranscriptReplica>()
  readonly #routes = new Map<string, string>()
  readonly #pending = new Map<string, TranscriptSignal[]>()
  readonly #lifetimes = new Map<string, AbortController>()
  readonly #listeners = new Map<string, Set<() => void>>()
  readonly #now: () => number
  /** 每条对话一根端口：身份就是对话号，切对话、入口页刚铸号都不会撞上「一根端口，换就抛错」。 */
  readonly #sessions = new Map<string, HeldSession>()
  /** 迁移过的键 → 它现在的键：迁移是转场，不是两个真相 —— 旧键的引用都落到同一格上。 */
  readonly #aliases = new Map<string, string>()
  /* 本机**见过**的提交号，只增不减。不能每次从投影现扫：收尾那条 `turn.upsert` 只带一次号，现扫会判成「没到过」（实测：回复跑完后出现两个用户气泡）。 */
  readonly #stamped = new Map<string, Set<string>>()
  /** 每条通道的投影备忘录，挂在副本（`#owners` 的值）上：副本被换掉或释放时随它回收，不必另维护删除路径。 */
  readonly #memos = new WeakMap<TranscriptReplica, Map<string, ProjectionMemo>>()
  /* 提交行**独立于 `#held` 存**：`submissions.changed` 常在转录格子建出来之前就到，靠格子存在才收会把那一条永远丢掉（真机故障：要等 AI 回复才出现气泡）。 */
  readonly #submissions = new Map<string, SubmissionView[]>()
  readonly #factory: SessionPortFactory | null
  /* 已绑过会话、Core 换代后还没重读过的对话。不能立刻整读所有对话 —— R-03 之后整读会 acquire 会话，那会一口气冷启动 N 个 AgentSession。 */
  readonly #stale = new Set<string>()
  #disposed = false
  #serial = 0

  constructor({
    now = Date.now,
    sessions,
  }: { readonly now?: () => number; readonly sessions?: SessionPortFactory } = {}) {
    this.#now = now
    this.#factory = sessions ?? null
  }

  /** 这条对话的待发队列视图：真相在 agent 里，这里只把它的快照按对话存一份好让屏幕订阅。 */
  queue = (threadId: string): MessageQueue => {
    const target = this.#resolveKey(threadId)
    const lifetime = this.#lifetime(target)
    const held = this.#queues.get(target)
    if (held !== undefined) {
      return held
    }
    const home = { key: target }
    const created = new MessageQueue({
      /* 抛在同步段里也安全：MessageQueue 那两头都在 try 里 await 它。 */
      withdraw: (itemId) => {
        lifetime.signal.throwIfAborted()
        return this.#requirePort(home.key).withdraw(itemId)
      },
      move: (itemId, deliverAs) => {
        lifetime.signal.throwIfAborted()
        return this.#requirePort(home.key).move(itemId, deliverAs)
      },
      setModes: (patch: DeliveryModePatch) => {
        lifetime.signal.throwIfAborted()
        return this.#requirePort(home.key).setDeliveryModes(patch)
      },
      failed: (cause) => {
        if (!lifetime.signal.aborted) {
          this.failed(home.key, cause)
        }
      },
    })
    this.#queueHomes.set(created, home)
    this.#queues.set(target, created)
    return created
  }
  answerQuestions = (key: string, response: QuestionResponse): Promise<void> =>
    this.#command(key, (port) => port.answerQuestions(response))
  answerDialog = (key: string, interactionId: string, answer: DialogAnswer): Promise<void> =>
    this.#command(key, (port) => port.answerDialog(interactionId, answer))
  dismissQuestions = (key: string, questionId: string): Promise<void> =>
    this.#command(key, (port) => port.dismissQuestions(questionId))
  async #command(key: string, perform: (port: AgentSessionPort) => Promise<void>): Promise<void> {
    const lifetime = this.#lifetime(addressOf(key).conversation)
    try {
      await perform(this.#requirePort(addressOf(key).conversation))
    } catch (cause) {
      if (!lifetime.signal.aborted) {
        this.failed(key, cause)
      }
      throw cause
    }
  }
  /** 这个键此刻的转录。别名解析在**读**这一侧：迁移之后握着草稿键的读者看到的是同一个事实，不是各自一份空表。 */
  read = (key: string): Transcript => this.#held.get(this.#resolveKey(key)) ?? EMPTY
  subscribe = (key: string, listener: () => void): (() => void) => {
    const target = this.#resolveKey(key)
    const listeners = this.#listeners.get(target) ?? new Set<() => void>()
    listeners.add(listener)
    this.#listeners.set(target, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.#listeners.delete(target)
      }
    }
  }

  /*
   * `#publish` 按 **agent 的 promptId** 收口，这一侧存的却是 **UI 铸的 clientTurnId** —— 词表没有交集，那一条永远收不掉，发送键一直转
   * （真实故障：对话已结束，键还在转圈）。判据是 `turn.upsert` 带回的 `clientTurnId`；已定性的 failed 不动 —— 那是对人的补救入口。
   */
  settleSubmissions = (threadId: string, clientTurnIds: readonly string[]): void => {
    if (this.#disposed || clientTurnIds.length === 0) {
      return
    }
    const key = this.#resolveKey(threadId)
    const current = this.#held.get(key)
    if (current === undefined) {
      return
    }
    const settled = new Set(clientTurnIds)
    const remaining = current.submissions.filter(
      (entry) => entry.phase === 'failed' || entry.promptId === null || !settled.has(entry.promptId),
    )
    if (remaining.length === current.submissions.length) {
      return
    }
    this.#put(key, { ...current, submissions: remaining })
  }

  waitForTerminal = (
    key: string,
    promptId: string,
    cancellation?: AbortSignal,
  ): Promise<'completed' | 'cancelled' | 'failed'> => {
    if (promptId.length === 0) {
      return Promise.reject(new InvariantError('A terminal waiter requires an acknowledged prompt ID.'))
    }
    const address = addressOf(key)
    const owned = this.#lifetime(address.conversation).signal
    const signal = cancellation === undefined ? owned : AbortSignal.any([owned, cancellation])
    signal.throwIfAborted()
    const read = () => {
      const snapshot = this.#owners.get(address.conversation)?.snapshot(address.agentId)
      return snapshot === undefined ? null : promptOutcome(snapshot, promptId)
    }
    const immediate = read()
    if (immediate !== null) {
      return Promise.resolve(immediate)
    }
    return new Promise((resolve, reject) => {
      let off: () => void = () => undefined
      const aborted = (): void => {
        off()
        signal.removeEventListener('abort', aborted)
        reject(signal.reason)
      }
      const inspect = (): void => {
        const outcome = read()
        if (outcome !== null) {
          off()
          signal.removeEventListener('abort', aborted)
          resolve(outcome)
        }
      }
      off = this.subscribe(key, inspect)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) {
        aborted()
      } else {
        inspect()
      }
    })
  }

  /** 这条对话用哪根端口：幂等，同一对话已经有端口时原样交回（不重新订阅、不换身份）。 */
  #requirePort = (threadId: string): AgentSessionPort => {
    if (this.#disposed) {
      invariant(false, 'TranscriptStore is disposed.')
    }
    const target = this.#resolveKey(threadId)
    if (target === '') {
      invariant(false, '这个界面还没有接上助手会话。')
    }
    const held = this.#sessions.get(target)
    if (held !== undefined) {
      return held.port
    }
    if (this.#factory === null) {
      invariant(false, '这个界面还没有接上助手会话。')
    }
    return this.#attach(target, this.#factory(target)).port
  }

  /** 只取已经握着的端口，不新建。 */
  #heldPort = (threadId: string): AgentSessionPort | undefined => this.#sessions.get(this.#resolveKey(threadId))?.port

  /** 把端口接到一条对话上并订阅四路通知；换端口时先退掉旧的四个订阅 —— 端口是唯一真相，留旧订阅就是两份事实写同一格。 */
  #attach = (threadId: string, port: AgentSessionPort): HeldSession => {
    const previous = this.#sessions.get(threadId)
    /* 同一个对象重复 attach 什么都不做，这是**常规路径**：重订阅会多出一份事实，StrictMode 的双渲染还会把订阅数翻倍。 */
    if (previous?.port === port) {
      return previous
    }
    if (previous !== undefined) {
      for (const off of previous.offs) {
        off()
      }
    }
    const held: HeldSession = {
      port,
      offs: [
        port.transcript.subscribeTranscript((signal) => this.#accept(signal)),
        port.subscribeQueue((queue) => this.#acceptQueue(queue)),
        port.subscribePromptDropped((dropped) => this.#acceptDropped(dropped)),
        port.subscribeRunFailed((failed) => this.#acceptRunFailed(failed)),
      ],
    }
    this.#sessions.set(threadId, held)
    return held
  }

  ensure = (threadId: string): void => {
    this.#requirePort(threadId)
  }

  /** 用**手上这一根**端口，而不是让工厂再建一根：入口页的端口随 `prepare` 到手，工厂那时还不知道这一格。 */
  #mountPort = (threadId: string, port: AgentSessionPort): AgentSessionPort => {
    if (this.#sessions.get(threadId)?.port === port) {
      return port
    }
    return this.#attach(threadId, port).port
  }

  /** 迁的是**这一格的身份**（提交记录、状态、队列对象、生命周期）。`from` 没有任何东西时也记别名：入口那格常是先有号再有第二次调用。 */
  #migrate = (from: string, to: string): void => {
    if (from === to) {
      return
    }
    /* 入口那一格（`''`）**不记别名**：它是「还没铸号」这个位置，不是某条对话。记成 `'' -> A` 后下次从入口页发消息会写进 A 的格子（真机实测：A 里冒出 `B:submitting` 幽灵记录）。 */
    if (from !== '') {
      this.#aliases.set(from, to)
    }
    const held = this.#held.get(from)
    if (held !== undefined) {
      this.#held.delete(from)
      this.#put(to, held)
    }
    const rows = this.#submissions.get(from)
    if (rows !== undefined) {
      this.#submissions.delete(from)
      this.#submissions.set(to, rows)
    }
    const queue = this.#queues.get(from)
    if (queue !== undefined) {
      this.#queues.delete(from)
      this.#queues.set(to, queue)
      const home = this.#queueHomes.get(queue)
      if (home !== undefined) home.key = to
    }
    const lifetime = this.#lifetimes.get(from)
    if (lifetime !== undefined) {
      this.#lifetimes.delete(from)
      this.#lifetimes.set(to, lifetime)
    }
    const listeners = this.#listeners.get(from)
    if (listeners !== undefined) {
      this.#listeners.delete(from)
      this.#listeners.set(to, listeners)
    }
  }

  #releasePort = (threadId: string): void => {
    const held = this.#sessions.get(threadId)
    if (held === undefined) {
      return
    }
    this.#sessions.delete(threadId)
    for (const off of held.offs) {
      off()
    }
  }

  #releasePorts = (): void => {
    for (const threadId of [...this.#sessions.keys()]) {
      this.#releasePort(threadId)
    }
  }

  dispose = (): void => {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    try {
      this.#releasePorts()
    } finally {
      for (const queue of this.#queues.values()) {
        queue.dispose()
      }
      this.#queues.clear()
      for (const lifetime of this.#lifetimes.values()) {
        lifetime.abort(new DOMException('Conversation runtime stopped.', 'AbortError'))
      }
      for (const owner of this.#owners.values()) {
        owner.dispose()
      }
      this.#lifetimes.clear()
      this.#owners.clear()
      this.#routes.clear()
      this.#pending.clear()
      this.#held.clear()
      this.#listeners.clear()
      this.#stale.clear()
    }
  }

  /** agent 报来的队列快照：端口按对话建，归属就是订阅它的那条对话，不必再经别的号反查。 */
  #acceptQueue = (queue: QueuedMessages): void => {
    if (this.#disposed) {
      return
    }
    this.#queues.get(queue.threadId)?.accept(queue)
  }

  /** 这一句在入队前就被取消：按正文找回还在提交中的那一条收成失败 —— **这句话没有落进会话文件**，不会有任何帧来解释它。 */
  #acceptDropped = ({ threadId, text }: DroppedPrompt): void => {
    if (this.#disposed) {
      return
    }
    const transcript = this.#held.get(threadId)
    if (transcript === undefined) {
      return
    }
    let hit = -1
    for (let index = transcript.submissions.length - 1; index >= 0; index -= 1) {
      const entry = transcript.submissions[index]
      if (entry !== undefined && entry.phase === 'submitting' && entry.text === text) {
        hit = index
        break
      }
    }
    if (hit < 0) {
      return
    }
    this.#put(threadId, {
      ...transcript,
      operation: {
        kind: 'failed',
        message: '这一句在送出去之前就被取消了（没有落进会话）。',
        blocks: false,
        indeterminate: false,
      },
      submissions: transcript.submissions.map((entry, index) =>
        index === hit ? { ...entry, phase: 'failed' as const } : entry,
      ),
    })
  }

  /* 不收的后果实测过：那一轮永远转下去，提交键变成「正在停止」然后消失，连发送键都没了，只能重启应用 —— 屏幕上的轮终只认 agent 的 transcript。判据是**会话号**。 */
  /*
   * 对话号 → **被本机收掉的那一轮**（编号 + 它是不是「跑完了只是掉了帧」）。**这是本机的事实，不是快照的投影** ——
   * 只写进 `timeline` 会被下一次投影整块覆盖，屏幕退回「正在处理」。
   * 存编号而不是布尔：管的是「那一轮已经终止」，不是「这条对话废了」。
   * 存 `degraded` 是因为**两种收尾要报不同的终局**：真的死在半路 → `aborted`（「已停止」），
   * 跑完了只是掉了帧 → 不写终局（「已完成」本来就是对的）。
   */
  #runFailed = new Map<string, { readonly turn: number; readonly degraded: boolean }>()

  /** **唯一的实现**，两个调用点：`#acceptRunFailed` 与 `#publish` —— 后者不能省，`timeline` 每次由快照重算，只贴一次会被冲掉。 */
  #withRunFailed(threadId: string | undefined, timeline: TimelineState): TimelineState {
    if (threadId === undefined) {
      return timeline
    }

    const failed = this.#runFailed.get(threadId)

    if (failed === undefined || failed.turn !== timeline.active.turn) {
      return timeline
    }

    /* `degraded` 的那一轮**是真的跑完了**，只是本机掉了帧：它报「已完成」是对的，不该改口成「已停止」。 */
    return settleActiveRun(timeline, failed.degraded ? undefined : 'aborted')
  }

  #acceptRunFailed = ({ threadId, message, degraded }: RunFailed): void => {
    if (this.#disposed) {
      return
    }
    const transcript = this.#held.get(threadId)
    if (transcript === undefined) {
      return
    }

    this.#runFailed.set(threadId, { turn: transcript.timeline.active.turn, degraded })

    /* 把还在等回执的那几条提交一并收成失败（这一轮已经没有回执可等）；已定性的 failed / delivered 不动 —— 收第二次会让记录改口。 */
    const settled = transcript.submissions.map((entry) =>
      entry.phase === 'submitting' ? { ...entry, phase: 'failed' as const } : entry,
    )

    this.#put(threadId, {
      ...transcript,
      restoring: false,
      timeline: this.#withRunFailed(threadId, transcript.timeline),
      /* 收尾对两种都做（那一轮不会再有帧了），报错只对真失败做：`degraded` 的 `message` 是一句内部诊断（英文、带帧数），弹成横幅会让跑完的一轮看起来像崩了。 */
      ...(degraded
        ? {}
        : {
            operation: {
              kind: 'failed' as const,
              message,
              blocks: false,
              indeterminate: false,
            },
          }),
      submissions: settled,
    })
  }

  route = (sessionId: string, threadId: string, baseline: TranscriptPage): void => {
    const owner = this.#bind(sessionId, threadId)
    owner.seed(baseline)
    this.#flush(sessionId)
    this.#observe(threadId, owner, owner.synchronize(MAIN_AGENT_ID))
    this.refreshQueue(threadId)
  }

  /** 读一次队列快照：推送是常规路，这一条只补「刚绑上一条会话」与「断线重连」两个缺口。 */
  refreshQueue = (key: string): void => {
    const port = this.#heldPort(key)
    if (port === undefined) {
      return
    }
    const lifetime = this.#lifetime(key)
    void port.readQueue().then(
      (queue) => {
        if (!lifetime.signal.aborted) {
          this.#acceptQueue(queue)
        }
      },
      () => {
        /* 读不到队列不算这条对话的失败：chip 那一栏空着，下一句照发。 */
      },
    )
  }

  /* 会话号 → 对话号，`#routes` 是唯一产地（由 `#bind` 写）。现在只有 SessionControlsStore 那一支读它，而那一支还没接上数据。 */
  ownerOf = (sessionId: string): string | undefined => this.#routes.get(sessionId)
  /* **幂等**：已绑定过且整读已落地（`loaded`）的不再整读，StrictMode 双渲染与切走再切回都不会重复全文往返。失败写进这条对话自己的 `operation`，不抛给渲染期。 */
  open = (threadId: string): void => {
    if (this.#disposed || threadId === '') {
      return
    }
    try {
      /* 换代后第一次再打开这条对话：先重读一遍（resync 之后 `loaded` 仍为 true，下面的整读分支不会再发请求）。 */
      if (this.#stale.has(threadId)) {
        this.#resync(threadId)
      }
      /* 已经绑过会话的对话不重绑：重绑会把已经建好的副本连同正文一起作废。 */
      const owner = this.#owners.get(threadId) ?? this.#bind(threadId, threadId)
      const current = this.read(threadId)
      if (!current.loaded && !current.restoring) {
        this.opening(threadId)
        this.#observe(threadId, owner, owner.refresh(MAIN_AGENT_ID))
      }
      this.refreshQueue(threadId)
    } catch (cause) {
      this.failed(threadId, cause)
    }
  }

  /**
   * 打开一条子代理通道（`对话号#子代理号`）：父对话先照常打开（绑会话），再整读这个子代理的 feed。
   * 不走 `open`：`open` 把键当对话号，会给通道键另绑一份副本 —— 那份副本永远收不到子代理的 ops（路由按会话号回到父对话）。
   * 已经整读过（`loaded`）的不再读：之后的增量随父对话的订阅按 agentId 分流进来。
   */
  openChannel = (key: string): void => {
    const address = delegateAddress(key)
    if (this.#disposed || address === null) {
      return
    }
    this.open(address.conversation)
    const owner = this.#owners.get(address.conversation)
    if (owner === undefined || this.read(key).loaded) {
      return
    }
    this.#observe(key, owner, owner.refresh(address.agentId))
  }

  /** 「Core 即时回显」：一条提交记录到达（订阅快照、通知、或 submit 的回复）。只接受**更大的 rev**，旧的不覆盖新的。 */
  upsertSubmission = (threadId: string, view: SubmissionView): void => {
    if (this.#disposed) return
    const key = this.#resolveKey(threadId)
    const held = this.#submissions.get(key) ?? []
    const at = held.findIndex((row) => row.clientTurnId === view.clientTurnId)
    if (at >= 0 && held[at] !== undefined && held[at].rev > view.rev) return
    const next = at < 0 ? [...held, view] : held.map((row, index) => (index === at ? view : row))
    this.#submissions.set(key, next)
    this.#render(key)
  }

  /**
   * Core 删掉了一条提交行（丢弃、排队项送达 / 撤回、被新的一句取代）。本机按同一个号铸的那条提交也在这里收口
   * （审查 R-20-1）：忙时发的一句被降级成排队，送达时没有任何 turn 带这个号，`settleSubmissions` 永远等不到它，
   * 发送键就一直报「已提交」。已定性的 failed 不动 —— 那是对人的补救入口，由 `send()` / 丢弃清。
   */
  removeSubmission = (threadId: string, clientTurnId: string): void => {
    if (this.#disposed) return
    const key = this.#resolveKey(threadId)
    const current = this.#submissions.get(key)
    const next = current?.filter((row) => row.clientTurnId !== clientTurnId)
    const rowsChanged = current !== undefined && next !== undefined && next.length !== current.length
    const held = this.#held.get(key)
    const local = held?.submissions.filter((entry) => entry.phase === 'failed' || entry.promptId !== clientTurnId)
    const localChanged = held !== undefined && local !== undefined && local.length !== held.submissions.length
    if (!rowsChanged && !localChanged) return
    if (rowsChanged) this.#submissions.set(key, next)
    if (localChanged) this.#put(key, { ...held, submissions: local })
    else this.#render(key)
  }
  opening = (threadId: string): void => {
    this.#lifetime(threadId)
    this.#put(threadId, { ...this.read(threadId), restoring: true })
  }
  failed = (key: string, cause: unknown, endsTurn = false): void => {
    this.#put(key, {
      ...this.read(key),
      restoring: false,
      operation: {
        kind: 'failed',
        message: describeFailure(cause),
        blocks: endsTurn,
        indeterminate: false,
      },
    })
  }
  forget = (threadId: string): void => {
    /* 端口本身无状态（每条命令现取），「释放」就是退订阅 + 忘记它；注册表从同一个入口走，所以不会有「store 忘了、注册表还留着」的半状态。 */
    this.#releasePort(threadId)
    this.#queues.get(threadId)?.dispose()
    this.#queues.delete(threadId)
    this.#lifetimes.get(threadId)?.abort(new DOMException('Conversation released.', 'AbortError'))
    this.#lifetimes.delete(threadId)
    const owner = this.#owners.get(threadId)
    owner?.dispose()
    this.#owners.delete(threadId)
    if (owner !== undefined) {
      this.#routes.delete(owner.sessionId)
      this.#pending.delete(owner.sessionId)
    }
    for (const key of this.#held.keys()) {
      if (addressOf(key).conversation === threadId) {
        this.#held.delete(key)
        this.#fire(key)
      }
    }
    this.#submissions.delete(threadId)
    this.#stamped.delete(threadId)
    this.#stale.delete(threadId)
    /* 别名一并清掉：把旧键解析到一条已不存在的对话上等于给幽灵续命（新对话拿到同一个 id、或旧回调晚到一步时都会写进不存在的格）。 */
    this.#aliases.delete(threadId)
    for (const [from, to] of [...this.#aliases]) {
      if (to === threadId) {
        this.#aliases.delete(from)
      }
    }
  }

  /** Core 丢失：所有已绑定的对话都不可信了。只打标记、不发请求 —— 此刻 Core 不可用，RPC 只会排队到超时。 */
  markAllStale = (): void => {
    for (const thread of this.#owners.keys()) {
      this.#stale.add(thread)
    }
  }

  /** Core 恢复：正在显示的对话立即重读，其余的留到下次 `open`；交回立即重读的线程号供调用方刷新控件表。 */
  resyncVisible = (): readonly string[] => {
    const now: string[] = []
    for (const thread of [...this.#stale]) {
      if (!this.#isMounted(thread)) {
        continue
      }
      this.#resync(thread)
      now.push(thread)
    }
    return now
  }

  /** `#listeners` 的键是通道键（对话号或 `对话号#子代理号`）：任何属于这条对话的键有监听者即视为在屏幕上。 */
  #isMounted(thread: string): boolean {
    for (const [key, listeners] of this.#listeners) {
      if (listeners.size > 0 && addressOf(key).conversation === thread) {
        return true
      }
    }
    return false
  }

  #resync(thread: string): void {
    this.#stale.delete(thread)
    const owner = this.#owners.get(thread)
    if (owner === undefined) {
      return
    }
    this.#observe(
      thread,
      owner,
      owner.receive({ kind: 'resync', sessionId: owner.sessionId, reason: 'core restarted' }),
    )
    this.refreshQueue(thread)
  }

  readEarlier = async (key: string): Promise<void> => {
    const address = addressOf(key)
    const owner = this.#owners.get(address.conversation)
    const current = this.read(key)
    if (owner === undefined || current.earlier === null || current.reading) {
      return
    }
    this.#put(key, { ...current, reading: true })
    try {
      await owner.readEarlier(address.agentId, current.earlier)
    } catch (cause) {
      if (this.#owners.get(address.conversation) === owner) {
        this.failed(key, cause)
        throw cause
      }
    } finally {
      if (this.#owners.get(address.conversation) === owner) {
        this.#put(key, { ...this.read(key), reading: false, revealing: null })
      }
    }
  }
  revealTurn = async (key: string, mark: TurnMark): Promise<void> => {
    while (!this.read(key).outline.some((item) => item.turnId === mark.turnId)) {
      const before = this.read(key).earlier
      if (before === null || this.read(key).reading) {
        return
      }
      await this.readEarlier(key)
      if (this.read(key).earlier === before) {
        invariant(false, 'Transcript pagination did not advance.')
      }
    }
  }

  send = async ({
    assets,
    configuration,
    deliverAs,
    onUserMessage,
    port: given,
    prepare,
    skills,
    text,
    threadId,
  }: SendOptions): Promise<AgentPromptHandle | null> => {
    /* 铸号之后换成新键，并把入口那一格的提交记录迁过去（`#migrate`），屏幕上不会在转场的一瞬间丢掉它。 */
    const entryKey = threadId
    const lifetime = this.#lifetime(entryKey)
    if (deliverAs !== 'turn') {
      return await this.#interject({
        assets,
        configuration,
        deliverAs,
        lifetime,
        ...(given === undefined ? {} : { port: given }),
        prepare,
        skills,
        text,
        threadId,
      })
    }
    const submission: PendingSubmission = {
      id: this.#serial++,
      text,
      submittedAt: this.#now(),
      phase: 'submitting',
      promptId: null,
    }
    /* **没出去**的失败是确定的（没有轮在跑），**出去了**的失败结果不明（回执可能只是没回来）。判据是「有没有走到 port.prompt」，不靠错误文案反推。 */
    let leftTheMachine = false
    const before = this.read(entryKey)
    this.#put(entryKey, {
      ...before,
      operation: { kind: 'ready' },
      promptId: null,
      /* 上一次失败到此为止：它没有被 `#publish` 收走的可能，留着就等于把人已经重发的那句「提交未完成」钉在屏幕上。取消的提交另有去处。 */
      submissions: [...before.submissions.filter((entry) => entry.phase !== 'failed'), submission],
    })
    let key = entryKey
    try {
      /* **先 prepare（铸号），再取端口** —— 反过来的话入口页永远发不出第一句：那一格的端口是建完号才有的（真实故障：「这个界面还没有接上助手会话。」）。 */
      const prepared = prepare === undefined ? undefined : await prepare()
      if (lifetime.signal.aborted) {
        return null
      }
      if (prepare !== undefined && prepared === null) {
        throw new AppError(conversationErrors.thread_start_failed, '无法开始新的对话。')
      }
      if (prepared !== null && prepared !== undefined) {
        key = prepared.key
        this.#migrate(entryKey, key)
      }
      const port = prepared?.port ?? given ?? this.#requirePort(key)
      this.#mountPort(key, port)
      onUserMessage?.(key, text)
      leftTheMachine = true
      /* 提交号由**界面铸**：Core 回显的那条记录带着同一个号，界面上那一条与真实 turn 靠它认成同一条。 */
      const clientTurnId = createId()
      const handle = await port.prompt({
        threadId: key,
        text,
        deliverAs,
        assets,
        configuration,
        skills,
        clientTurnId,
      })
      if (handle.submission !== undefined) this.upsertSubmission(key, handle.submission)
      if (lifetime.signal.aborted) {
        return null
      }
      if (handle.promptId.length === 0) {
        invariant(false, '代理返回了没有提交身份的收据；请先核对会话，不要重复发送。')
      }
      const owner = this.#bind(handle.sessionId, key)
      const current = this.read(key)
      const remaining = current.submissions.filter((entry) => entry.id !== submission.id)
      const snapshot = owner.snapshot(MAIN_AGENT_ID)
      const visible = snapshot !== undefined && knownPromptIds(snapshot).has(handle.promptId)
      const accepted: PendingSubmission = {
        ...submission,
        phase: 'accepted',
        promptId: handle.promptId,
      }
      this.#put(key, {
        ...current,
        promptId: handle.promptId,
        submissions: visible ? remaining : [...remaining, accepted],
      })
      this.#flush(handle.sessionId)
      this.#observe(key, owner, owner.synchronize(MAIN_AGENT_ID))
      return handle
    } catch (cause) {
      if (!lifetime.signal.aborted) {
        const current = this.read(key)
        this.#put(key, {
          ...current,
          restoring: false,
          operation: {
            kind: 'failed',
            message: describeFailure(cause),
            blocks: true,
            indeterminate: leftTheMachine,
          },
          submissions: current.submissions.map(
            (entry): PendingSubmission => (entry.id === submission.id ? { ...entry, phase: 'failed' } : entry),
          ),
        })
      }
      return null
    }
  }

  /**
   * 一句插话。与开一轮那条路的全部差别：**不开乐观轮**（这句话进 agent 的队列，模型看见它时桥会推一条帧）、不记提交、不认号。
   * 失败仍然要说：`kind: failed` 但 `blocks: false` —— 这一句话没进去，正在跑的那一轮却没受影响，不该把输入框锁住。
   */
  async #interject(options: SendOptions & { readonly lifetime: AbortController }): Promise<AgentPromptHandle | null> {
    const { assets, configuration, deliverAs, lifetime, port, prepare, skills, text, threadId } = options
    let key = threadId
    try {
      const prepared = prepare === undefined ? undefined : await prepare()
      if (lifetime.signal.aborted) {
        return null
      }
      if (prepare !== undefined && prepared === null) {
        throw new AppError(conversationErrors.thread_start_failed, '无法开始新的对话。')
      }
      if (prepared !== null && prepared !== undefined) {
        key = prepared.key
        this.#migrate(threadId, key)
      }
      const session = prepared?.port ?? port ?? this.#requirePort(key)
      this.#mountPort(key, session)
      const handle = await session.prompt({
        threadId: key,
        text,
        deliverAs,
        assets,
        configuration,
        skills,
      })
      return lifetime.signal.aborted ? null : handle
    } catch (cause) {
      if (!lifetime.signal.aborted) {
        this.#put(key, {
          ...this.read(key),
          restoring: false,
          operation: {
            kind: 'failed',
            message: describeFailure(cause),
            blocks: false,
            indeterminate: true,
          },
        })
      }
      return null
    }
  }

  cancel = (key: string): void => {
    const current = this.read(key)
    const thread = addressOf(key).conversation
    const port = this.#heldPort(thread)
    if (port === undefined || current.operation.kind === 'cancelling') {
      return
    }
    if (!selectIsBusy(current.timeline) && !deliveryUnknown(current)) {
      if (current.submissions.some((entry) => entry.phase !== 'failed')) {
        this.note(key, '消息仍在提交；确认接收后才能停止运行。')
      }
      return
    }
    const lifetime = this.#lifetime(thread)
    this.#put(key, { ...current, operation: { kind: 'cancelling' } })
    void port.cancel(thread).catch((cause: unknown) => {
      if (!lifetime.signal.aborted) {
        this.failed(key, cause)
      }
    })
  }
  resolvePermission = (key: string, requestId: string, answer: ApprovalAnswer): void => {
    const thread = addressOf(key).conversation
    const lifetime = this.#lifetime(thread)
    const port = this.#heldPort(thread)
    if (port === undefined) {
      this.note(key, '这个界面还没有接上助手会话。')
      return
    }
    void port.resolvePermission(requestId, answer).catch((cause: unknown) => {
      if (!lifetime.signal.aborted) {
        this.note(key, describeFailure(cause))
      }
    })
  }
  resolvePlan = (key: string, requestId: string, answer: PlanAnswer): void => {
    const thread = addressOf(key).conversation
    const lifetime = this.#lifetime(thread)
    const port = this.#heldPort(thread)
    if (port === undefined) {
      this.note(key, '这个界面还没有接上助手会话。')
      return
    }
    void port.resolvePlan(requestId, answer).catch((cause: unknown) => {
      if (!lifetime.signal.aborted) {
        this.note(key, describeFailure(cause))
      }
    })
  }
  note = (key: string, message: string): void => {
    /* 用户可见的失败：包成 AppError（错误码取内核兜底那一档），走同一套失败呈现。 */
    this.failed(key, new AppError(SystemErrorCode.internal, message))
  }

  #lifetime(thread: string): AbortController {
    if (this.#disposed) {
      invariant(false, 'TranscriptStore is disposed.')
    }
    const held = this.#lifetimes.get(thread)
    if (held !== undefined) {
      return held
    }
    const created = new AbortController()
    this.#lifetimes.set(thread, created)
    return created
  }
  #bind(sessionId: string, thread: string): TranscriptReplica {
    const previous = this.#owners.get(thread)
    if (previous?.sessionId === sessionId) {
      return previous
    }
    if (this.#disposed) {
      invariant(false, 'TranscriptStore is disposed.')
    }
    const claimant = this.#routes.get(sessionId)
    if (claimant !== undefined && claimant !== thread) {
      invariant(false, 'A transcript session already belongs to another conversation.')
    }
    if (previous !== undefined) {
      previous.dispose()
      this.#owners.delete(thread)
      this.#routes.delete(previous.sessionId)
      this.#pending.delete(previous.sessionId)
      for (const key of this.#held.keys()) {
        if (key !== thread && addressOf(key).conversation === thread) {
          this.#held.delete(key)
          this.#fire(key)
        }
      }

      const current = this.read(thread)
      this.#put(thread, {
        ...EMPTY,
        submissions: current.submissions,
        promptId: current.promptId,
        operation: current.operation,
        restoring: true,
      })
    }
    this.#lifetime(thread)
    /* 这一格的端口：正常路径上它一定在（`send` 先跑 `ensure`）；没有就当场说出来，不凭空造一根。 */
    const port = this.#requirePort(thread)
    const owner: TranscriptReplica = new TranscriptReplica(sessionId, port.transcript, (agentId, snapshot) => {
      if (this.#owners.get(thread) === owner) {
        this.#publish(thread, agentId, snapshot)
      }
    })
    this.#owners.set(thread, owner)
    this.#routes.set(sessionId, thread)
    return owner
  }
  #accept(signal: TranscriptSignal): void {
    if (this.#disposed) {
      return
    }
    const thread = this.#routes.get(signal.sessionId)
    const owner = thread === undefined ? undefined : this.#owners.get(thread)
    if (thread !== undefined && owner !== undefined) {
      this.#observe(
        signal.kind === 'resync' ? thread : channelKey(thread, signal.agentId),
        owner,
        owner.receive(signal),
      )
      return
    }
    const pending = this.#pending.get(signal.sessionId) ?? []
    if (pending.some((item) => item.kind === 'resync')) {
      return
    }
    if (!this.#pending.has(signal.sessionId) && this.#pending.size >= PENDING_SIGNAL_LIMIT) {
      const oldest = this.#pending.keys().next().value
      if (oldest !== undefined) {
        this.#pending.delete(oldest)
      }
    }
    this.#pending.set(
      signal.sessionId,
      signal.kind === 'resync' || pending.length >= PENDING_SIGNAL_LIMIT
        ? [{ kind: 'resync', sessionId: signal.sessionId, reason: 'transcript recovery required' }]
        : [...pending, signal],
    )
  }
  #flush(sessionId: string): void {
    const pending = this.#pending.get(sessionId) ?? []
    this.#pending.delete(sessionId)
    for (const signal of pending) {
      this.#accept(signal)
    }
  }
  #observe(key: string, owner: TranscriptReplica, work: Promise<void>): void {
    void work.catch((cause: unknown) => {
      if (this.#owners.get(addressOf(key).conversation) === owner) {
        this.failed(key, cause)
      }
    })
  }
  #publish(thread: string, agentId: string, snapshot: AgentTranscriptSnapshot): void {
    const key = channelKey(thread, agentId)
    const current = this.read(key)
    const turns = snapshot.items.filter((item) => item.kind === 'turn')
    const owner = this.#owners.get(thread)
    const memo = this.#memoOf(owner, agentId)
    const projected = projectTranscript(snapshot, memo)
    /*
     * 投影是纯的；本机那条「这一轮已经终止」在这里补上。**这是唯一的收口点** —— 写进上一份 `timeline` 是假修复
     * （`timeline` 每次都由快照重算，那一份连同判据一起被丢掉），两处都写就分不清是谁生效。
     */
    const timeline = this.#withRunFailed(owner?.sessionId, projected)
    const remaining = remainingSubmissions(current.submissions, snapshot)
    this.#put(key, {
      ...current,
      timeline,
      restoring: false,
      loaded: true,
      owned: true,
      earlier: snapshot.hasMoreOlder ? (turns[0]?.turnId ?? null) : null,
      outline: outlineOf(snapshot, memo),
      operation:
        current.operation.kind === 'cancelling' && !selectIsBusy(timeline) ? { kind: 'ready' } : current.operation,
      submissions: remaining,
    })
  }
  #memoOf(owner: TranscriptReplica | undefined, agentId: string): ProjectionMemo {
    if (owner === undefined) {
      return createProjectionMemo()
    }
    const byAgent = this.#memos.get(owner) ?? new Map<string, ProjectionMemo>()
    this.#memos.set(owner, byAgent)
    const memo = byAgent.get(agentId) ?? createProjectionMemo()
    byAgent.set(agentId, memo)
    return memo
  }
  #put(key: string, next: Transcript): void {
    const target = this.#resolveKey(key)
    if (this.#disposed || this.#held.get(target) === next) {
      return
    }
    /* 提交行按对话存在 `#submissions`（它先于格子存在）：每次写格子时从那张表取**当前应有的一份**，不信调用方带进来的。 */
    const rows = this.#submissions.get(target) ?? []
    const withRows: Transcript = { ...next, submissionRows: rows }
    const seen = this.#stamped.get(target) ?? new Set<string>()
    for (const id of clientTurnIdsOf(withRows.timeline)) seen.add(id)
    this.#stamped.set(target, seen)
    /*
     * 提交行合进时间线：真实 turn 画出来之前，屏幕上那一条用户消息就是 Core 存下的**真实记录**（不是界面造的）。
     * 合并点选在唯一写入口，投影、通知、失败回滚三条路都覆盖到；真实 turn 带上同一个 clientTurnId 后它自然消失。
     */
    const merged = withSubmissionRows(withRows, seen)
    this.#held.set(target, { ...merged, status: activityOf(merged) })
    this.#fire(target)
  }

  #render(key: string): void {
    const target = this.#resolveKey(key)
    const current = this.#held.get(target)
    if (current !== undefined) {
      /* 传浅拷贝：`#put` 按引用判「没变」会提前返回，同一引用就永远画不出来。 */
      this.#put(target, { ...current })
    }
  }
  #resolveKey = (key: string): string => {
    let target = key
    for (let hops = 0; hops < 8; hops += 1) {
      const next = this.#aliases.get(target)
      if (next === undefined) {
        return target
      }
      target = next
    }
    return target
  }
  #fire(key: string): void {
    for (const listener of this.#listeners.get(this.#resolveKey(key)) ?? []) {
      listener()
    }
  }
}
