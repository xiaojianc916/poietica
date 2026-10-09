import { AppError, createId, InvariantError, invariant, SystemErrorCode } from '@poietica/foundation'
import type { AgentTranscriptSnapshot } from '@poietica/transcript'
import type { SubmissionView } from '../../contract'
import { conversationErrors } from '../../contract'
import type { ApprovalAnswer } from '../agent/permission'
import type { PlanAnswer } from '../agent/plan'
import type { QuestionResponse } from '../agent/question'
import type { RunStatus } from '../agent/run'
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
} from '../agent/session'
import type { TurnMark } from '../agent/thread'
import type { TranscriptPage, TranscriptSignal } from '../agent/transcript'
import { describeFailure } from '../failure'
import { MessageQueue } from '../interjection/message-queue'
import { delegateAddress, delegateKey } from '../timeline/delegate-channel'
import { createTimelineState, isInFlight, type TimelineItem, type TimelineState } from '../timeline/timeline-contract'
import { selectIsBusy } from '../timeline/timeline-queries'
import { knownPromptIds, outlineOf, projectTranscript, promptOutcome } from './transcript-projector'
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
      /**
       * 这一句已经离开本机，而回执没回来 —— 那一轮**可能还在跑**。
       *
       * 与 `blocks` 分开：`blocks` 说的是「这个失败还算不算数」，这里说的是「我们到底
       * 知不知道它没在跑」。只有后者需要停止键，而它不能由错误文案反推。
       */
      readonly indeterminate: boolean
    }

/**
 * 投递结果不明：这一轮**到底跑没跑起来我们并不知道** —— 回执正是没回来的那一样。
 *
 * 它不改这一格的状态（`failed` 是「刚才那一下没成」这个事实的正确答案），只多给出一条
 * 「可能还有一轮在跑」：停止键认它。真正确认没跑起来时，取消是一次空转。
 */
export function deliveryUnknown(transcript: Transcript): boolean {
  return transcript.operation.kind === 'failed' && transcript.operation.indeterminate
}

/** 现在能不能停：在飞，或者投递结果不明（可能还有一轮在跑）。 */
export function canCancel(transcript: Transcript): boolean {
  return selectIsBusy(transcript.timeline) || deliveryUnknown(transcript)
}

/**
 * 把时间线上那一轮标成已结束（本机判定它再也不会动了）。
 *
 * 只动 `active.run.settled`：其余（items、usage、spans）是 agent 说过的事实，
 * 我们无权改写。`run` 缺席时什么都不做 —— 那一轮本来就没在跑。
 */
function settleActiveRun(timeline: TimelineState): TimelineState {
  const run = timeline.active.run

  if (run === undefined || run.settled) {
    return timeline
  }

  return {
    ...timeline,
    status: 'failed',
    active: { ...timeline.active, run: { ...run, settled: true } },
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
  /**
   * 「Core 即时回显」的提交行（方案第 5 节）：Core 存下并推回来的真实记录。
   * 时间线在真实 turn 画得出来之前，画的是这一份。
   */
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
  /**
   * 把这一条提交要落的对话准备好，交回它此刻的键与端口。
   *
   * 入口那一格还没有对话号：号由 Core 在 `threads.create` 里铸（05 页 §11.4），
   * 所以键只能在 prepare 之后才知道 —— 之后每一步（乐观提交、取端口、提交）都用它。
   * legacy 的号是渲染进程自己铸的，才能先有号再 prepare；数据来源换了，先后的形状
   * 跟着它走。
   *
   * 交回 null 表示这一刻开不出对话（例如还没选工作区）；抛出的错误原样上屏，
   * 那一句正文跟着「提交未完成」一起留在输入框上（可以取回）。
   */
  readonly prepare?: (() => Promise<PreparedThread | null>) | undefined
  /**
   * 这条对话此刻的端口（由 ui/session-registry.ts 单点持有身份）。
   *
   * 入口那一格第一句话发出之前它不存在 —— 那时端口随 `prepare` 一起到手。
   */
  readonly port?: AgentSessionPort | undefined
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
}
const MAIN_AGENT_ID = 'main'
const PENDING_SIGNAL_LIMIT = 64

/**
 * 一条对话此刻握着的那根端口，以及它的四个订阅。
 *
 * 每一条对话各有一份：端口按对话建（stores/session-port.ts 的头注），订阅随它生、
 * 随它灭 —— 一次连接一条会话，正是 §11.4 六个命名空间里 `threadId` 的粒度。
 */
interface HeldSession {
  readonly port: AgentSessionPort
  readonly offs: readonly (() => void)[]
}

/**
 * 入口页那一格准备好之后的产物：这一条提交要落的对话，以及它此刻的端口。
 *
 * 两样一起交回（而不是只交号）：端口也正是在这一刻才建得出来的 —— 它按对话号建，
 * 而号是刚刚才铸的（ui/components/home-surface.tsx 的 prepare）。
 */
export interface PreparedThread {
  readonly key: string
  readonly port: AgentSessionPort
}

/** 提交行在时间线里的条目 id 前缀（换真实 turn 时靠它把上一份剔掉）。 */
const SUBMISSION_ITEM_PREFIX = 'submission:'

/**
 * 时间线里此刻已有的真实 turn 号（`clientTurnId`）。
 *
 * 判据是**真实 turn 已经画得出来**：投影里那一轮带上了提交号，才算「换过了」。
 */
function stampedTurns(timeline: TimelineState): ReadonlySet<string> {
  const stamped = new Set<string>()
  const pages = [...timeline.sealed, timeline.active]
  for (const page of pages) {
    for (const item of page.items) {
      if (item.type !== 'user_message') continue
      const id = (item as { readonly clientTurnId?: unknown }).clientTurnId
      if (typeof id === 'string' && id !== '') stamped.add(id)
    }
  }
  return stamped
}

/**
 * 把 Core 的提交行并进时间线（方案第 5 节）。
 *
 * 只画 `deliverAs === 'turn'` 且还没被真实 turn 换掉的那些 —— 插话与排队不进时间线，
 * 它们由队列区显示（`queue.changed`）。真实 turn 到达后 Core 不再返回这条记录，
 * 这里自然就少了一行。
 */
function withSubmissionRows(next: Transcript, seen: ReadonlySet<string> = new Set()): Transcript {
  /*
   * 先剔掉上一轮贴进来的提交条目，再贴当前应有的那一份。
   *
   * `#put` 会被调很多次（提交、通知、投影），而 `next.timeline` 可能就是上一份已经贴过
   * 提交条目的快照 —— 不先剔就会越贴越多（实测：一次发送出现 3~7 条一样的用户气泡）。
   */
  const stripped = next.timeline.active.items.some((item) => item.id.startsWith(SUBMISSION_ITEM_PREFIX))
    ? {
        ...next.timeline,
        active: {
          ...next.timeline.active,
          items: next.timeline.active.items.filter((item) => !item.id.startsWith(SUBMISSION_ITEM_PREFIX)),
        },
      }
    : next.timeline
  const rows = next.submissionRows.filter((row) => row.deliverAs === 'turn' && row.status !== 'queued')
  if (rows.length === 0) {
    return stripped === next.timeline ? next : { ...next, timeline: stripped }
  }
  /* 本机见过的提交号 + 投影里带号的真实轮，两处合起来才算「真轮已经换过这条提交」。 */
  const stamped = new Set([...stampedTurns(stripped), ...seen])
  const pending = rows.filter((row) => !stamped.has(row.clientTurnId))
  if (pending.length === 0) {
    return { ...next, timeline: stripped }
  }
  const items: TimelineItem[] = pending.map((row) => ({
    type: 'user_message',
    id: `${SUBMISSION_ITEM_PREFIX}${row.clientTurnId}`,
    turn: stripped.active.turn,
    at: row.createdAt,
    text: row.text,
    ...(row.skills.length === 0 ? {} : { skills: row.skills }),
  }))
  /*
   * 插在本轮开头：用户那一句是一轮的第一条，agent 的正文全在它后面。
   * 与真实投影里 `projectTurn` 把用户消息放最前同形 —— 换的那一帧 DOM 才不跳。
   */
  return {
    ...next,
    timeline: {
      ...stripped,
      active: { ...stripped.active, items: [...items, ...stripped.active.items] },
    },
  }
}

/**
 * 端口工厂：把对话号变成它的会话端口。
 *
 * 由功能的组装点注入（ui/index.tsx）：那里既有 `api`，也知道「哪些通知该转给谁」。
 * store 不 import 自己的 api，只认这个函数形状 —— 与 `TranscriptSink` 同一条理由。
 *
 * 身份由 ui/session-registry.ts 单点持有：同一条对话永远交回同一个对象，
 * 所以 `#attach` 的「同一对象重复 attach 什么都不做」是常规路径而不是巧合。
 */
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

export class TranscriptStore implements TranscriptSink {
  readonly #queues = new Map<string, MessageQueue>()
  readonly #held = new Map<string, Transcript>()
  readonly #owners = new Map<string, TranscriptReplica>()
  readonly #routes = new Map<string, string>()
  readonly #pending = new Map<string, TranscriptSignal[]>()
  readonly #lifetimes = new Map<string, AbortController>()
  readonly #listeners = new Map<string, Set<() => void>>()
  readonly #runningListeners = new Set<() => void>()
  readonly #now: () => number
  #running = new Set<string>()
  /**
   * 每条对话一根端口，键是对话号。
   *
   * legacy 里全应用只有一根连接（一个 agent 进程一棵会话树），所以上游那个 store 写的是
   * 「一根端口，换就抛错」。新架构里「一条会话」的身份就是对话号（stores/session-port.ts
   * 的头注），端口因此按对话建 —— 切对话、入口页刚铸号都不会再撞上那条抛错。
   */
  readonly #sessions = new Map<string, HeldSession>()
  /**
   * 迁移过的键 → 它现在的键。
   *
   * 入口那一格在发出第一句话时从草稿键迁到真对话号（`#migrate`），而屏幕上那一刻
   * 可能还有旧键的引用在手上（入口页的队列对象、刚交出去的回调）。这一条让它们
   * 落到同一格上，而不是各开一份 —— 迁移是转场，不是两个真相。
   */
  readonly #aliases = new Map<string, string>()
  /**
   * 本地时间线副本里**见过**的提交号（方案第 5 节的 `stamped`）。
   *
   * 只增不减：真轮一旦出现过，这条提交就不该再画。不能每次从投影里现扫 ——
   * 收尾那条 `turn.upsert` 只带一次号，之后投影里可能就没有了，现扫会判成「没到过」，
   * 提交行又会被贴回来（实测：AI 回复跑完后出现两个用户气泡）。
   */
  readonly #stamped = new Map<string, Set<string>>()
  /**
   * 每条对话的提交行（方案第 5 节「每个线程一个 submissions 存储」）。
   *
   * **独立于 `#held` 存**：Core 的 `submissions.changed` 常常在界面为这条对话建出转录
   * 格子之前就到了（提交发生在挂载整读之前），靠格子存在才收的写法会把那一条永远丢掉 ——
   * 屏幕上的气泡就只能等 omp 的真实 turn 帧来画（真机故障：发送后要等 AI 回复才出现）。
   * 存成自己的表，来源先到先存，格子什么时候建起来什么时候画。
   */
  readonly #submissions = new Map<string, SubmissionView[]>()
  /** 端口的工厂；由功能的组装点注入（ui/index.tsx）。缺席即没有会话可接。 */
  readonly #factory: SessionPortFactory | null
  #disposed = false
  #serial = 0

  constructor({
    now = Date.now,
    sessions,
  }: { readonly now?: () => number; readonly sessions?: SessionPortFactory } = {}) {
    this.#now = now
    this.#factory = sessions ?? null
  }

  /**
   * 这条对话的待发队列视图。
   *
   * 队列的真相在 agent 里（一次连接一条会话），这里只是把它报来的快照按对话存一份，
   * 好让屏幕订阅。写动作（撤回、改模式）原样交回端口。
   */
  queue = (threadId: string): MessageQueue => {
    /* 别名先解到底：入口那一格迁到真对话号之后，两条键问的是同一份队列。 */
    const target = this.#resolveKey(threadId)
    const lifetime = this.#lifetime(target)
    const held = this.#queues.get(target)
    if (held !== undefined) {
      return held
    }
    const created = new MessageQueue({
      /* 抛在同步段里也安全：MessageQueue 那两头都在 try 里 await 它。 */
      withdraw: () => {
        lifetime.signal.throwIfAborted()
        return this.#requirePort(target).withdraw()
      },
      setModes: (patch: DeliveryModePatch) => {
        lifetime.signal.throwIfAborted()
        return this.#requirePort(target).setDeliveryModes(patch)
      },
      failed: (cause) => {
        if (!lifetime.signal.aborted) {
          this.failed(target, cause)
        }
      },
    })
    this.#queues.set(target, created)
    return created
  }
  answerQuestions = (key: string, response: QuestionResponse): Promise<void> =>
    this.#command(key, (port) => port.answerQuestions(response))
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
  /**
   * 这个键此刻的转录。
   *
   * 别名解析在**读**这一侧：入口那一格迁到真对话号之后，手上还握着草稿键的读者
   * （入口页的队列、刚交出去的回调）看到的是同一个事实，而不是各自的一份空表。
   */
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
  runningSnapshot = (): ReadonlySet<string> => this.#running
  subscribeRunning = (listener: () => void): (() => void) => {
    this.#runningListeners.add(listener)
    return () => this.#runningListeners.delete(listener)
  }

  /**
   * 本机说这几条提交已经在时间线上落地了。
   *
   * 为什么需要这一口：`#publish` 的收口按 **agent 的 promptId** 收
   * （`knownPromptIds` 扫的是快照里 prompt 自己的号），而我们这一侧存的 promptId 是
   * **UI 铸的 clientTurnId**（`stores/session-port.ts` 的 `prompt` 把它当 promptId 交回）。
   * 两个词表没有交集 —— 那一条提交永远收不掉，`activityOf` 恒判「提交中」，屏幕上的
   * 发送键就一直转（真实故障：对话已经结束，那颗键还在转圈）。
   *
   * 判据就是 `turn.upsert` 带回来的 `clientTurnId`（05 页 §12.2）：真实那一轮出现了，
   * 这一句就不再是「待发」。已经定性为失败的那些不动 —— `failed` 是给人看的补救入口，
   * 收掉它等于把「取回文字」那颗键一起收走。
   *
   * 空数组是空操作（调用方不必先判），超过上限的键也不怕：这是本机自己的号表。
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

  /**
   * 这条对话用哪根端口：已经有就用那一根，还没有就现建一根。
   *
   * 幂等：同一对话已经有端口时原样交回（重复 ensure 不重新订阅、不换身份）。
   * 没有工厂（Store 被裸构造，例如单测）时抛出 —— 与 legacy「没有会话」同一句话。
   */
  #requirePort = (threadId: string): AgentSessionPort => {
    if (this.#disposed) {
      invariant(false, 'TranscriptStore is disposed.')
    }
    const target = this.#resolveKey(threadId)
    if (target === '') {
      /* 入口那一格还没有号：这一刻没有会话可接（正常路径上 prepare 会先把它铸出来）。 */
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

  /** 已经握着的端口，不新建。给「没有就是没有」的读法用（队列刷新、图像代取）。 */
  #heldPort = (threadId: string): AgentSessionPort | undefined => this.#sessions.get(this.#resolveKey(threadId))?.port

  /**
   * 把一根端口接到一条对话上，并订阅它的四路通知。
   *
   * 同一条对话换一根端口（例如重连后重建）时先把旧的四个订阅退掉 —— 端口这一层是
   * 每条对话的唯一真相，留着旧订阅就是两份事实在写同一格。
   */
  #attach = (threadId: string, port: AgentSessionPort): HeldSession => {
    const previous = this.#sessions.get(threadId)
    /*
     * 同一个对象重复 attach：什么都不做。
     *
     * 这是**常规路径**（端口的身份由 ui/session-registry.ts 单点持有：同一条对话永远
     * 交回同一个对象），不是巧合 —— 重订阅会多出一份事实，StrictMode 的双渲染也会因此
     * 把订阅数翻倍。
     */
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

  /**
   * 用**手上这一根**端口，而不是让工厂再建一根。
   *
   * 入口页那条路的端口是随 `prepare` 一起到手的（那一格的号刚铸出来，工厂那时候还
   * 不知道它），所以这里直接把它挂上；同一对象重复挂是幂等的。
   */
  #mountPort = (threadId: string, port: AgentSessionPort): AgentSessionPort => {
    if (this.#sessions.get(threadId)?.port === port) {
      return port
    }
    return this.#attach(threadId, port).port
  }

  /**
   * 把 `from` 那一格上的东西迁到 `to` 上，并把 `from` 记成别名。
   *
   * 迁移的是**这一格的身份**：提交记录、状态、队列对象、生命周期。入口那一格在
   * 发出第一句话时走这一条（草稿键 → 真对话号），产物是「这一句仍然在屏幕上，
   * 只是它现在属于那条对话」。
   *
   * `from` 没有任何东西时也照样记别名：入口那一格的第一句话常常是先有号（prepare）
   * 再有第二次调用，别名让两条路落到同一格。
   */
  #migrate = (from: string, to: string): void => {
    if (from === to) {
      return
    }
    /*
     * 入口那一格（`''`）**不记别名**。
     *
     * 它是「还没铸号」这一个位置，不是某条对话：第一次发送把它迁到 A 之后再记成
     * `'' -> A`，下次从入口页发消息时那句提交就会写进 A 的格子（真机实测：A 里冒出
     * 一条 `B:submitting` 的幽灵记录），而新对话的格子那时还不存在，Core 推来的
     * 提交行无处可落 —— 新气泡只能等 AI 回复跑完才被真实 turn 画出来。
     */
    if (from !== '') {
      this.#aliases.set(from, to)
    }
    const held = this.#held.get(from)
    if (held !== undefined) {
      this.#held.delete(from)
      this.#put(to, held)
    }
    /* 提交行也要跟着走：它独立于格子存（见 `#submissions` 的头注）。 */
    const rows = this.#submissions.get(from)
    if (rows !== undefined) {
      this.#submissions.delete(from)
      this.#submissions.set(to, rows)
    }
    const queue = this.#queues.get(from)
    if (queue !== undefined) {
      this.#queues.delete(from)
      this.#queues.set(to, queue)
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

  /** 退掉一条对话的端口订阅并忘记它。 */
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

  /** 退掉全部端口的订阅。dispose 与 forget 共用（那里退一条）。 */
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
      this.#running = new Set()
      this.#runningListeners.clear()
    }
  }

  /**
   * agent 报来的一份队列快照。
   *
   * 端口是**按对话**建的一根（stores/session-port.ts 的头注），所以这份快照的归属
   * 就是订阅它的那条对话 —— 不需要再经别的号反查。端口在转交前已经按号过滤过
   * （`subscribeQueue` 只报这条对话的），这里直接落到它的队列格上。
   */
  #acceptQueue = (queue: QueuedMessages): void => {
    if (this.#disposed) {
      return
    }
    this.#queues.get(queue.threadId)?.accept(queue)
  }

  /**
   * 这一句在入队前就被取消了。
   *
   * 归属直接是 port 报来的那条对话（与 `#acceptQueue` 同一条理由）：那条对话名下的
   * 提交记录里按正文找回还在提交中的那一条，收成失败并说清楚：**这句话没有落进
   * 会话文件**，不会有任何帧来解释它。
   */
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

  /**
   * 本机说这一轮失败了（agent 连接断开、进程没了）。
   *
   * 与 `#acceptDropped` 同一件事的**更大一号**：那一条收的是「这一句没送出去」，
   * 这一条收的是「整轮终止了」。两者都必须收，因为屏幕上的轮终只认 agent 的
   * transcript —— 而 agent 已经死了，那条通道再也不会有帧。
   *
   * 不收的后果实测过：那一轮永远转下去，提交键变成「正在停止」然后消失，
   * 连发送键都没有了，只能重启应用。
   *
   * 判据是**会话号**（与 dropped 同一条理由）：这条事件按会话到，得先认出它属于哪条对话。
   */
  /*
   * 本机判定「这一轮终止了」的那条事实。
   *
   * **它是本机的事实，不是 agent 快照的投影** —— 所以它必须住在自己的一格里，
   * 不能写进 `timeline`：`#publish` 每来一次快照就把 `timeline` 整块重算并覆盖，
   * 写进去的判据会被下一次投影冲掉，屏幕退回「正在处理」。
   *
   * 生效点在 `#publish`：投影之后就地收口，投影本身保持是纯函数。
   */
  /*
   * 对话号 → **被本机收掉的那一轮的编号**。
   *
   * 存编号而不是一个布尔：这条事实管的是「那一轮已经终止」，不是「这条对话废了」。
   * 后来的轮次是**另一轮**，它该怎么显示由 agent 的投影说了算 —— 不存编号就会把
   * 之后每一轮都强行收成已结束（转圈不出现、封条说已完成，而那一轮其实还在跑）。
   * 编号一变这条事实就自然失效，不必另设清理时机。
   */
  #runFailed = new Map<string, number>()

  /**
   * 把本机那条「这一轮终止了」贴到时间线上。
   *
   * **唯一的实现**，两个调用点：`#acceptRunFailed`（事实刚到的这一刻）与 `#publish`
   * （每一次投影之后）。后者不能省：`timeline` 是快照的重算产物，只贴一次会被下一次
   * 投影冲掉，屏幕退回「正在处理」。
   *
   * 只贴给**被收掉的那一轮**（按编号认）。后来的轮次是另一轮，由 agent 的投影说了算。
   */
  #withRunFailed(threadId: string | undefined, timeline: TimelineState): TimelineState {
    if (threadId === undefined) {
      return timeline
    }

    /* 编号对不上就是另一轮了：那条事实与它无关，让它按 agent 的投影显示。 */
    if (this.#runFailed.get(threadId) !== timeline.active.turn) {
      return timeline
    }

    return settleActiveRun(timeline)
  }

  #acceptRunFailed = ({ threadId, message, degraded }: RunFailed): void => {
    if (this.#disposed) {
      return
    }
    const transcript = this.#held.get(threadId)
    if (transcript === undefined) {
      return
    }

    /* 记在这条对话名下：下一次投影（以及任何一次投影）都会把它重新应用上去。 */
    this.#runFailed.set(threadId, transcript.timeline.active.turn)

    /*
     * 把还在等回执的那几条提交一并收成失败：这一轮已经没有回执可等了。
     * 已经定了性的（failed / delivered）不动 —— 收第二次会让屏幕上那条记录改口。
     */
    const settled = transcript.submissions.map((entry) =>
      entry.phase === 'submitting' ? { ...entry, phase: 'failed' as const } : entry,
    )

    this.#put(threadId, {
      ...transcript,
      restoring: false,
      /* 事实刚到：立刻贴上（这一刻还没有下一次投影）。 */
      timeline: this.#withRunFailed(threadId, transcript.timeline),
      /*
       * 收尾对两种都做（那一轮都不会再有帧了），报错只对真失败做。
       *
       * `degraded` 是「这一轮跑完了，只是我们自己的帧记录掉了帧」—— 那种时候
       * `message` 是一句内部诊断（英文、带帧数），弹成失败横幅会让跑完的一轮看起来
       * 像崩了。原样留着 `operation`，屏幕照常显示这一轮已完成。
       */
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
    /* 刚绑上这条会话：队列此刻是什么样，读一次。之后的变由 agent 自己推。 */
    this.refreshQueue(threadId)
  }

  /**
   * 读一次队列快照。
   *
   * 推送是常规路（谁排了一句、谁撤回、模型看见它，agent 都会报），这一条只补两个缺口：
   * 刚绑上一条会话（还没有任何变化事件），以及一次断线重连之后。
   */
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
        /* 读不到队列不是这条对话的失败：chip 那一栏空着，下一句照发。 */
      },
    )
  }

  /*
   * 会话号 → 对话号。`#routes` 是这条对应关系的唯一产地，由 `#bind` 写。
   *
   * 现在还读它的只有 SessionControlsStore 那一支（按 `sessionId` 认领 agent 主动
   * 报来的控件表/用量）—— 那一支在新架构里还没有接上数据（组合根只传了
   * `transcripts`），所以这里是留给它的接口，不是当前数据路。
   */
  ownerOf = (sessionId: string): string | undefined => this.#routes.get(sessionId)
  /**
   * 打开一条对话：接上端口、整读一次时间线、读一次队列。
   *
   * 新架构里「打开」不再是宿主交回一整份 `OpenedThread`（那是 legacy 的形状），
   * 时间线要经 `timeline.subscribe` 现取 —— 这一条就是那次现取的入口，由会话页
   * 挂载时的 effect 调用（components/transcript/use-assistant-session.ts）。
   *
   * **幂等**：已经绑定过、且整读已经落地的（`loaded`）不再整读一次；重复调用只
   * 补一次队列读数。这样 StrictMode 的双渲染、切走再切回来都不会重复全文往返。
   *
   * 失败往这条对话自己的 `operation` 上写（`#observe`/`failed`），不抛给渲染期 ——
   * effect 里抛出去只会炸掉整棵树，而「这一条读不回来」是这一格的事。
   */
  open = (threadId: string): void => {
    if (this.#disposed || threadId === '') {
      return
    }
    try {
      /*
       * 已经绑过会话的对话不重绑：`route` 那条路（控件表报回来时）用的会话号是引擎
       * 签的，重绑会把已经建好的副本连同正文一起作废。
       */
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
   * 「Core 即时回显」：一条提交记录到达（订阅快照、通知、或 submit 的回复）。
   *
   * 只接受**更大的 rev**（方案第 5 节）：三个来源先后无所谓，旧的那一份不覆盖新的。
   */
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

  /** 一条失败的提交被丢弃（`submissions.removed`）。 */
  removeSubmission = (threadId: string, clientTurnId: string): void => {
    if (this.#disposed) return
    const key = this.#resolveKey(threadId)
    const current = this.#submissions.get(key)
    if (current === undefined) return
    const next = current.filter((row) => row.clientTurnId !== clientTurnId)
    if (next.length === current.length) return
    this.#submissions.set(key, next)
    this.#render(key)
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
    /*
     * 卸掉这条对话的端口：订阅归零、端口表里那一格消失。
     *
     * 端口自己是无状态的（每条命令都现取），所以「释放」在这里就是退订阅 + 忘记它；
     * 注册表（ui/session-registry.ts）看见同一个调用也会把它那一格一起收掉 —— 两处
     * 都从这一个入口走，所以不会有「store 忘了、注册表还留着」的半状态。
     */
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
    /* 提交行也随这条对话一起收掉（它独立于格子存）。 */
    this.#submissions.delete(threadId)
    this.#stamped.delete(threadId)
    /*
     * 别名也要一并清掉：这条对话已经不存在了，把旧键再解析到它上面等于给幽灵续命
     * （新对话拿到同一个 id、或者旧回调晚到一步时，都会写进一个不存在的格）。
     */
    this.#aliases.delete(threadId)
    for (const [from, to] of [...this.#aliases]) {
      if (to === threadId) {
        this.#aliases.delete(from)
      }
    }
    this.#publishRunning()
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
    /*
     * 这一句落在哪条对话上：入口那一格还没有号，prepare 之后才知道。
     *
     * 在此之前的一切（提交记录、失败横幅、那一条「提交未完成」的正文）都记在**调用
     * 方给的那个键**上 —— 入口那一格就是 `''`。prepare 铸出号之后，这一次提交里
     * 往后每一步（乐观提交、端口、提交、收据）都换成新键，并把入口那一格的那条
     * 提交记录迁到新键下面（`#migrate`），屏幕上因此不会在转场的一瞬间丢掉它。
     */
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
    /*
     * 这一句到底有没有离开本机。它决定失败该报哪一种：**没出去**的失败是确定的
     * （没有轮在跑），**出去了**的失败结果不明（回执可能只是没回来，那一轮也许正在跑）。
     * 判据就是「有没有走到 port.prompt」这一步，不靠错误文案反推。
     */
    let leftTheMachine = false
    const before = this.read(entryKey)
    this.#put(entryKey, {
      ...before,
      operation: { kind: 'ready' },
      promptId: null,
      /*
       * 上一次失败到此为止。它没有被 `#publish` 收走的可能（`promptId` 是 null，永远
       * 留在表里），留着就等于把「提交未完成」那句话连同补救入口钉在屏幕上 —— 人已经
       * 重发了，横幅还在说上一句。取消的提交另有去处（`#publish` 按号收），不在这里。
       */
      submissions: [...before.submissions.filter((entry) => entry.phase !== 'failed'), submission],
    })
    /* 到这一刻为止，这一条提交落在哪条对话上。失败横幅与正文取回认的就是它。 */
    let key = entryKey
    try {
      /*
       * 顺序：**先 prepare（铸号），再取端口**。
       *
       * 反过来的话入口页永远发不出第一句：那一格的端口是建完号才有的（真实故障：
       * 「这个界面还没有接上助手会话。」）。这一条与 07 页 §5E 的「乐观提交」同序：
       * 身份先落地，再谈提交。
       */
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
      /*
       * 提交号由**界面铸**（方案第 5 节）：Core 回显的那条记录带着同一个号，界面上那一条
       * 与真实 turn 靠它认成同一条。铸在这里而不是 Core，是因为界面要在提交前就知道号。
       */
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
      /* 兜底：通知通常先到，这里再写一次（rev 判重，旧的不覆盖新的）。 */
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
            /* 没出去 = 确定没有轮在跑；出去了而回执没回来 = 结果不明，可能还在跑。 */
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
   * 一句插话。
   *
   * 与开一轮那条路的**全部差别**在这里：
   * - 不开乐观轮：这句话进的是 agent 的队列，模型看见它的那一刻桥会推一条帧
   *   （`projection.ts` 的 steeredFrame），屏幕上因此不会先长出一轮再作废。
   * - 不记提交、不认号：插话没有官方轮身份，收据只是「agent 收下了」。
   * - 队列 chip 由 agent 报来（`subscribeQueue`），这一侧不排第二份队。
   *
   * 失败仍然要说：`kind: failed` 但 `blocks: false` —— 这一句话没进去，正在跑的那一轮
   * 却没受影响，不该把输入框锁住。结果不明时（回执没回来）标 indeterminate：
   * 它可能已经排在队里了，屏幕上的队列快照会说明到底进没进。
   */
  async #interject(options: SendOptions & { readonly lifetime: AbortController }): Promise<AgentPromptHandle | null> {
    const { assets, configuration, deliverAs, lifetime, port, prepare, skills, text, threadId } = options
    let key = threadId
    try {
      /* 与开一轮同一条顺序：先 prepare（可能铸号），再取端口。 */
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
  /** 答一张计划卡片（04 页 §3.12 第 5 支）：与审批同一条路，只是答复类型不同。 */
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
    /*
     * 这一格的端口：这条对话此刻握着的那一根。
     *
     * 正常路径上它一定在（`send` 先跑 `ensure`，`route` 也从端口回填走同一条路）；
     * 没有就当场说出来，不凭空造一根。
     */
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
    /*
     * 投影是纯的；本机那条「这一轮已经终止」在这里补上。
     *
     * 补在这里而不是写进上一份 `timeline`：`timeline` 每次都由快照重算，
     * 上一份连同写进去的判据一起被丢掉 —— 屏幕会退回「正在处理」。
     */
    const projected = projectTranscript(snapshot)
    /*
     * 投影是纯的；本机那条「这一轮已经终止」在这里补上。
     *
     * **这是唯一的收口点。** 写进上一份 `timeline` 是假修复：`timeline` 每次都由快照
     * 重算，那一份连同写进去的判据一起被丢掉，屏幕退回「正在处理」。
     * 收在一处，这条不变量才可证 —— 两处都写就分不清是谁生效。
     */
    const timeline = this.#withRunFailed(owner?.sessionId, projected)
    const known = knownPromptIds(snapshot)
    const remaining = current.submissions.filter((entry) => entry.promptId === null || !known.has(entry.promptId))
    this.#put(key, {
      ...current,
      timeline,
      restoring: false,
      loaded: true,
      owned: true,
      earlier: snapshot.hasMoreOlder ? (turns[0]?.turnId ?? null) : null,
      outline: outlineOf(snapshot),
      operation:
        current.operation.kind === 'cancelling' && !selectIsBusy(timeline) ? { kind: 'ready' } : current.operation,
      submissions: remaining.length === current.submissions.length ? current.submissions : remaining,
    })
  }
  #put(key: string, next: Transcript): void {
    const target = this.#resolveKey(key)
    if (this.#disposed || this.#held.get(target) === next) {
      return
    }
    /*
     * 提交行按对话存在 `#submissions`（它先于格子存在，见那张表的头注）：
     * 每次写格子时从那张表取**当前应有的一份**，而不是信调用方带进来的。
     */
    const rows = this.#submissions.get(target) ?? []
    const withRows: Transcript = { ...next, submissionRows: rows }
    /*
     * 记下这一份时间线里出现的提交号（方案第 5 节 `stamped` 的来源）。
     * 写完再合并提交行 —— 判据与记录在同一次写里对齐。
     */
    const seen = this.#stamped.get(target) ?? new Set<string>()
    for (const id of stampedTurns(withRows.timeline)) seen.add(id)
    this.#stamped.set(target, seen)
    /*
     * 提交行合进时间线（方案第 5 节）：Core 还没把真实 turn 画出来之前，
     * 屏幕上那一条用户消息就是 Core 存下的**真实记录**（不是界面造的）。
     *
     * 合并点选在这里（唯一写入口），投影、通知、失败回滚三条路就都覆盖到；
     * 真实 turn 到达并带上同一个 clientTurnId 后，Core 不再返回这条提交行，
     * 它自然消失 —— 不需要界面对账。
     */
    const merged = withSubmissionRows(withRows, seen)
    this.#held.set(target, { ...merged, status: activityOf(merged) })
    this.#publishRunning()
    this.#fire(target)
  }

  /** 提交行变了：有格子就重画那一条，没有就先存着（格子建起来时从 `#submissions` 取）。 */
  #render(key: string): void {
    const target = this.#resolveKey(key)
    const current = this.#held.get(target)
    if (current !== undefined) {
      /* 传浅拷贝：`#put` 按引用判「没变」会提前返回，同一引用就永远画不出来。 */
      this.#put(target, { ...current })
    }
  }
  /** 别名解到最后的那一格：迁移过的键与它的新键是同一格。 */
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
  #publishRunning(): void {
    const next = new Set<string>()
    for (const [key, value] of this.#held) {
      if (isInFlight(value.status)) {
        next.add(addressOf(key).conversation)
      }
    }
    if (next.size === this.#running.size && [...next].every((key) => this.#running.has(key))) {
      return
    }
    this.#running = next
    for (const listener of this.#runningListeners) {
      listener()
    }
  }
}
