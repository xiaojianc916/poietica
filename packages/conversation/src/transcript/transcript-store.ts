import type { AgentTranscriptSnapshot } from '@poietica/transcript'
import type { ApprovalAnswer } from '../agent/permission'
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
import { createTimelineState, isInFlight, type TimelineState } from '../timeline/timeline-contract'
import { selectIsBusy } from '../timeline/timeline-queries'
import {
  knownPromptIds,
  needsMediaFetch,
  outlineOf,
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
  readonly port: AgentSessionPort | undefined
  readonly threadId: string
  readonly text: string
  readonly deliverAs: PromptDelivery
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
  readonly prepare?: (() => Promise<boolean>) | undefined
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
}
const MAIN_AGENT_ID = 'main'
const PENDING_SIGNAL_LIMIT = 64
/** 一张图的字节最多代取几次：重试要挡得住抖动，又不能变成每次发布都发一遍。 */
const MEDIA_ATTEMPTS = 3
const EMPTY: Transcript = {
  timeline: createTimelineState(),
  status: 'idle',
  operation: { kind: 'ready' },
  submissions: [],
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
  /**
   * 历史图片字节的代取缓存：sessionId -> (fileId -> data URL)。
   *
   * media 端点要 Bearer，webview 直连不了，经端口让原生侧代取；内层 Map 不可变
   * 更新（每次解析完换一张新 Map），投影器按 Map 身份判断缓存是否失效。
   */
  readonly #media = new Map<string, Map<string, string>>()
  /**
   * 已经在取、或取失败还在等下文的媒体：`sessionId␟fileId` -> 已经试过几次。
   *
   * 有次数上限：`#requestMedia` 每次发布都会跑，而「这张图的服务端 fileId 已经
   * 不存在」是永久的 —— 不留上限就是每次流式 delta 都发一次注定失败的请求。
   * 换会话与放掉对话都会清掉它（#dropMedia），重开对话自然再试。
   */
  readonly #mediaAttempts = new Map<string, number>()
  readonly #now: () => number
  #running = new Set<string>()
  #port: AgentSessionPort | null = null
  #off: (() => void) | null = null
  #offQueue: (() => void) | null = null
  #offDropped: (() => void) | null = null
  #offRunFailed: (() => void) | null = null
  #disposed = false
  #serial = 0

  constructor({ now = Date.now }: { readonly now?: () => number } = {}) {
    this.#now = now
  }

  /**
   * 这条对话的待发队列视图。
   *
   * 队列的真相在 agent 里（一次连接一条会话），这里只是把它报来的快照按对话存一份，
   * 好让屏幕订阅。写动作（撤回、改模式）原样交回端口。
   */
  queue = (threadId: string): MessageQueue => {
    const lifetime = this.#lifetime(threadId)
    const held = this.#queues.get(threadId)
    if (held !== undefined) {
      return held
    }
    const created = new MessageQueue({
      /* 抛在同步段里也安全：MessageQueue 那两头都在 try 里 await 它。 */
      withdraw: () => {
        lifetime.signal.throwIfAborted()
        const port = this.#port
        if (port === null) {
          throw new Error('这个界面还没有接上助手会话。')
        }
        return port.withdraw()
      },
      setModes: (patch: DeliveryModePatch) => {
        lifetime.signal.throwIfAborted()
        const port = this.#port
        if (port === null) {
          throw new Error('这个界面还没有接上助手会话。')
        }
        return port.setDeliveryModes(patch)
      },
      failed: (cause) => {
        if (!lifetime.signal.aborted) {
          this.failed(threadId, cause)
        }
      },
    })
    this.#queues.set(threadId, created)
    return created
  }
  answerQuestions = (key: string, response: QuestionResponse): Promise<void> =>
    this.#command(key, (port) => port.answerQuestions(response))
  dismissQuestions = (key: string, questionId: string): Promise<void> =>
    this.#command(key, (port) => port.dismissQuestions(questionId))
  async #command(key: string, perform: (port: AgentSessionPort) => Promise<void>): Promise<void> {
    const lifetime = this.#lifetime(addressOf(key).conversation)
    try {
      const port = this.#port
      if (port === null) {
        throw new Error('这个界面还没有接上助手会话，答复没有送出去。')
      }
      await perform(port)
    } catch (cause) {
      if (!lifetime.signal.aborted) {
        this.failed(key, cause)
      }
      throw cause
    }
  }
  read = (key: string): Transcript => this.#held.get(key) ?? EMPTY
  subscribe = (key: string, listener: () => void): (() => void) => {
    const listeners = this.#listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.#listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.#listeners.delete(key)
      }
    }
  }
  runningSnapshot = (): ReadonlySet<string> => this.#running
  subscribeRunning = (listener: () => void): (() => void) => {
    this.#runningListeners.add(listener)
    return () => this.#runningListeners.delete(listener)
  }

  waitForTerminal = (
    key: string,
    promptId: string,
    cancellation?: AbortSignal,
  ): Promise<'completed' | 'cancelled' | 'failed'> => {
    if (promptId.length === 0) {
      return Promise.reject(new Error('A terminal waiter requires an acknowledged prompt ID.'))
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

  ensure = (port: AgentSessionPort): void => {
    if (this.#disposed) {
      throw new Error('TranscriptStore is disposed.')
    }
    if (this.#port === port) {
      return
    }
    if (this.#port !== null) {
      throw new Error('A transcript store cannot change its session port.')
    }
    this.#off = port.transcript.subscribeTranscript((signal) => this.#accept(signal))
    this.#offQueue = port.subscribeQueue((queue) => this.#acceptQueue(queue))
    this.#offDropped = port.subscribePromptDropped((dropped) => this.#acceptDropped(dropped))
    this.#offRunFailed = port.subscribeRunFailed((failed) => this.#acceptRunFailed(failed))
    this.#port = port
  }

  dispose = (): void => {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    try {
      this.#off?.()
      this.#offQueue?.()
      this.#offDropped?.()
      this.#offRunFailed?.()
    } finally {
      this.#off = null
      this.#offQueue = null
      this.#offDropped = null
      this.#offRunFailed = null
      this.#port = null
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
      this.#media.clear()
      this.#mediaAttempts.clear()
      this.#running = new Set()
      this.#runningListeners.clear()
    }
  }

  /**
   * agent 报来的一份队列快照。
   *
   * 按会话号找到它属于哪条对话（`#routes` 是这条对应关系的唯一产地）：队列是会话级的
   * 事实，而屏幕是按对话订阅的。还没绑上对话的会话（刚开、还没读首页）就丢掉 ——
   * 下一次读命令会补上，猜测一个归属只会把 chip 画到别人的对话上。
   */
  #acceptQueue = (queue: QueuedMessages): void => {
    if (this.#disposed) {
      return
    }
    const threadId = this.ownerOf(queue.sessionId)
    if (threadId === undefined) {
      return
    }
    this.#queues.get(threadId)?.accept(queue)
  }

  /**
   * 这一句在入队前就被取消了。
   *
   * 事件按会话到（它带 `sessionId`），所以归属由 `ownerOf` 定 —— 那条对话名下的
   * 提交记录里按正文找回还在提交中的那一条，收成失败并说清楚：**这句话没有落进
   * 会话文件**，不会有任何帧来解释它。
   */
  #acceptDropped = ({ sessionId, text }: DroppedPrompt): void => {
    if (this.#disposed) {
      return
    }
    const key = this.ownerOf(sessionId)
    if (key === undefined) {
      return
    }
    const transcript = this.#held.get(key)
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
    this.#put(key, {
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
   * 会话号 → **被本机收掉的那一轮的编号**。
   *
   * 存编号而不是一个布尔：这条事实管的是「那一轮已经终止」，不是「这条会话废了」。
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
  #withRunFailed(sessionId: string | undefined, timeline: TimelineState): TimelineState {
    if (sessionId === undefined) {
      return timeline
    }

    /* 编号对不上就是另一轮了：那条事实与它无关，让它按 agent 的投影显示。 */
    if (this.#runFailed.get(sessionId) !== timeline.active.turn) {
      return timeline
    }

    return settleActiveRun(timeline)
  }

  #acceptRunFailed = ({ sessionId, message, degraded }: RunFailed): void => {
    if (this.#disposed) {
      return
    }
    const key = this.ownerOf(sessionId)
    if (key === undefined) {
      return
    }
    const transcript = this.#held.get(key)
    if (transcript === undefined) {
      return
    }

    /* 记在会话名下：下一次投影（以及任何一次投影）都会把它重新应用上去。 */
    this.#runFailed.set(sessionId, transcript.timeline.active.turn)

    /*
     * 把还在等回执的那几条提交一并收成失败：这一轮已经没有回执可等了。
     * 已经定了性的（failed / delivered）不动 —— 收第二次会让屏幕上那条记录改口。
     */
    const settled = transcript.submissions.map((entry) =>
      entry.phase === 'submitting' ? { ...entry, phase: 'failed' as const } : entry,
    )

    this.#put(key, {
      ...transcript,
      restoring: false,
      /* 事实刚到：立刻贴上（这一刻还没有下一次投影）。 */
      timeline: this.#withRunFailed(sessionId, transcript.timeline),
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
    const port = this.#port
    if (port === null) {
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

  ownerOf = (sessionId: string): string | undefined => this.#routes.get(sessionId)
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
      this.#dropMedia(owner.sessionId)
    }
    for (const key of this.#held.keys()) {
      if (addressOf(key).conversation === threadId) {
        this.#held.delete(key)
        this.#fire(key)
      }
    }
    this.#publishRunning()
  }

  /** 丢掉一条会话的代取缓存与尝试计数：换会话或放掉这条对话都从这里走。 */
  #dropMedia = (sessionId: string): void => {
    this.#media.delete(sessionId)
    const prefix = `${sessionId}\u241f`
    for (const key of this.#mediaAttempts.keys()) {
      if (key.startsWith(prefix)) {
        this.#mediaAttempts.delete(key)
      }
    }
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
        throw new Error('Transcript pagination did not advance.')
      }
    }
  }

  send = async ({
    assets,
    configuration,
    deliverAs,
    onUserMessage,
    port,
    prepare,
    skills,
    text,
    threadId,
  }: SendOptions): Promise<AgentPromptHandle | null> => {
    const lifetime = this.#lifetime(threadId)
    if (deliverAs !== 'turn') {
      return await this.#interject({
        assets,
        configuration,
        deliverAs,
        lifetime,
        port,
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
    const before = this.read(threadId)
    this.#put(threadId, {
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
    try {
      if (port === undefined) {
        throw new Error('这个界面还没有接上助手会话。')
      }
      this.ensure(port)
      const ready = await (prepare?.() ?? Promise.resolve(true))
      if (lifetime.signal.aborted) {
        return null
      }
      if (!ready) {
        throw new Error('无法开始新的对话。')
      }
      onUserMessage?.(threadId, text)
      leftTheMachine = true
      const handle = await port.prompt({ threadId, text, deliverAs, assets, configuration, skills })
      if (lifetime.signal.aborted) {
        return null
      }
      if (handle.promptId.length === 0) {
        throw new Error('代理返回了没有提交身份的收据；请先核对会话，不要重复发送。')
      }
      const owner = this.#bind(handle.sessionId, threadId)
      const current = this.read(threadId)
      const remaining = current.submissions.filter((entry) => entry.id !== submission.id)
      const snapshot = owner.snapshot(MAIN_AGENT_ID)
      const visible = snapshot !== undefined && knownPromptIds(snapshot).has(handle.promptId)
      const accepted: PendingSubmission = {
        ...submission,
        phase: 'accepted',
        promptId: handle.promptId,
      }
      this.#put(threadId, {
        ...current,
        promptId: handle.promptId,
        submissions: visible ? remaining : [...remaining, accepted],
      })
      this.#flush(handle.sessionId)
      this.#observe(threadId, owner, owner.synchronize(MAIN_AGENT_ID))
      return handle
    } catch (cause) {
      if (!lifetime.signal.aborted) {
        const current = this.read(threadId)
        this.#put(threadId, {
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
            (entry): PendingSubmission =>
              entry.id === submission.id ? { ...entry, phase: 'failed' } : entry,
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
  async #interject(
    options: SendOptions & { readonly lifetime: AbortController },
  ): Promise<AgentPromptHandle | null> {
    const { assets, configuration, deliverAs, lifetime, port, prepare, skills, text, threadId } =
      options
    try {
      if (port === undefined) {
        throw new Error('这个界面还没有接上助手会话。')
      }
      this.ensure(port)
      const ready = await (prepare?.() ?? Promise.resolve(true))
      if (lifetime.signal.aborted) {
        return null
      }
      if (!ready) {
        throw new Error('无法开始新的对话。')
      }
      const handle = await port.prompt({
        threadId,
        text,
        deliverAs,
        assets,
        configuration,
        skills,
      })
      return lifetime.signal.aborted ? null : handle
    } catch (cause) {
      if (!lifetime.signal.aborted) {
        this.#put(threadId, {
          ...this.read(threadId),
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
    const port = this.#port
    const current = this.read(key)
    if (port === null || current.operation.kind === 'cancelling') {
      return
    }
    if (!selectIsBusy(current.timeline) && !deliveryUnknown(current)) {
      if (current.submissions.some((entry) => entry.phase !== 'failed')) {
        this.note(key, '消息仍在提交；确认接收后才能停止运行。')
      }
      return
    }
    const thread = addressOf(key).conversation
    const lifetime = this.#lifetime(thread)
    this.#put(key, { ...current, operation: { kind: 'cancelling' } })
    void port.cancel(thread).catch((cause: unknown) => {
      if (!lifetime.signal.aborted) {
        this.failed(key, cause)
      }
    })
  }
  resolvePermission = (key: string, requestId: string, answer: ApprovalAnswer): void => {
    const lifetime = this.#lifetime(addressOf(key).conversation)
    const port = this.#port
    if (port === null) {
      this.note(key, '这个界面还没有接上助手会话。')
      return
    }
    void port.resolvePermission(requestId, answer).catch((cause: unknown) => {
      if (!lifetime.signal.aborted) {
        this.note(key, describeFailure(cause))
      }
    })
  }
  note = (key: string, message: string): void => {
    this.failed(key, new Error(message))
  }

  #lifetime(thread: string): AbortController {
    if (this.#disposed) {
      throw new Error('TranscriptStore is disposed.')
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
    if (this.#port === null || this.#disposed) {
      throw new Error('TranscriptStore has no active session port.')
    }
    const claimant = this.#routes.get(sessionId)
    if (claimant !== undefined && claimant !== thread) {
      throw new Error('A transcript session already belongs to another conversation.')
    }
    if (previous !== undefined) {
      previous.dispose()
      this.#owners.delete(thread)
      this.#routes.delete(previous.sessionId)
      this.#pending.delete(previous.sessionId)
      this.#dropMedia(previous.sessionId)
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
    const owner: TranscriptReplica = new TranscriptReplica(
      sessionId,
      this.#port.transcript,
      (agentId, snapshot) => {
        if (this.#owners.get(thread) === owner) {
          this.#publish(thread, agentId, snapshot)
        }
      },
    )
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
    const media = owner === undefined ? undefined : this.#media.get(owner.sessionId)
    /*
     * 投影是纯的；本机那条「这一轮已经终止」在这里补上。
     *
     * 补在这里而不是写进上一份 `timeline`：`timeline` 每次都由快照重算，
     * 上一份连同写进去的判据一起被丢掉 —— 屏幕会退回「正在处理」。
     */
    const projected = projectTranscript(snapshot, media)
    /*
     * 投影是纯的；本机那条「这一轮已经终止」在这里补上。
     *
     * **这是唯一的收口点。** 写进上一份 `timeline` 是假修复：`timeline` 每次都由快照
     * 重算，那一份连同写进去的判据一起被丢掉，屏幕退回「正在处理」。
     * 收在一处，这条不变量才可证 —— 两处都写就分不清是谁生效。
     */
    const timeline = this.#withRunFailed(owner?.sessionId, projected)
    if (owner !== undefined) {
      this.#requestMedia(thread, agentId, owner.sessionId, snapshot)
    }
    const known = knownPromptIds(snapshot)
    const remaining = current.submissions.filter(
      (entry) => entry.promptId === null || !known.has(entry.promptId),
    )
    this.#put(key, {
      ...current,
      timeline,
      restoring: false,
      loaded: true,
      owned: true,
      earlier: snapshot.hasMoreOlder ? (turns[0]?.turnId ?? null) : null,
      outline: outlineOf(snapshot),
      operation:
        current.operation.kind === 'cancelling' && !selectIsBusy(timeline)
          ? { kind: 'ready' }
          : current.operation,
      submissions:
        remaining.length === current.submissions.length ? current.submissions : remaining,
    })
  }
  #put(key: string, next: Transcript): void {
    if (this.#disposed || this.#held.get(key) === next) {
      return
    }
    this.#held.set(key, { ...next, status: activityOf(next) })
    this.#publishRunning()
    this.#fire(key)
  }
  /**
   * 把这页里还没拿到字节的历史图片排上代取。
   *
   * 投影器对没解析的图片只给占位；这里经端口让原生侧代取 media 端点（webview
   * 带不了 Bearer），回来后换一张新的 media 表再重投一次。
   */
  #requestMedia(
    thread: string,
    agentId: string,
    sessionId: string,
    snapshot: AgentTranscriptSnapshot,
  ): void {
    const port = this.#port
    if (port === null) {
      return
    }
    const resolved = this.#media.get(sessionId)
    /*
     * 只扫这一页真的引用到的附件。
     *
     * 发布是每帧一次（流式 delta 也走这里），而附件表是整条会话累积的（每条消息的图都在
     * 里面、永不删）。全量扫的代价与「这条会话发过多少张图」成正比，而真正待取的永远是
     * 少数几张 —— 先按引用挑出候选，再在候选上判 needsMediaFetch。
     */
    const referenced = new Set<string>()
    for (const item of snapshot.items) {
      if (item.kind !== 'turn' || item.attachmentIds === undefined) {
        continue
      }
      for (const id of item.attachmentIds) {
        referenced.add(id)
      }
    }
    for (const attachment of snapshot.attachments) {
      if (!referenced.has(attachment.attachmentId) || !needsMediaFetch(attachment)) {
        continue
      }
      // needsMediaFetch 已经保证 source 存在且不是现成的 URL。
      const { fileId } = attachment.source as { readonly fileId: string }
      if (resolved?.has(fileId) === true) {
        continue
      }
      const requestKey = `${sessionId}\u241f${fileId}`
      const attempts = this.#mediaAttempts.get(requestKey) ?? 0
      if (attempts >= MEDIA_ATTEMPTS) {
        continue
      }
      this.#mediaAttempts.set(requestKey, attempts + 1)
      const lifetime = this.#lifetimes.get(thread)
      void port.transcript.readMedia(sessionId, fileId).then(
        ({ mediaType, base64 }) => {
          if (lifetime?.signal.aborted) {
            return
          }
          const previous = this.#media.get(sessionId)
          this.#media.set(
            sessionId,
            new Map(previous).set(fileId, `data:${mediaType};base64,${base64}`),
          )
          this.#republishMedia(sessionId, thread, agentId)
        },
        () => {
          /* 代取失败：这一张留在占位，不挡对话。次数记着而不是清掉 ——
             服务端永久没有这个 fileId 时，清掉就是每次 delta 重发一次。 */
        },
      )
    }
  }
  /** 媒体表换了一张新 Map 之后，用 owner 手上的快照重投这一格。 */
  #republishMedia(sessionId: string, thread: string, agentId: string): void {
    if (this.#disposed) {
      return
    }
    const owner = this.#owners.get(thread)
    if (owner === undefined || owner.sessionId !== sessionId) {
      return
    }
    const snapshot = owner.snapshot(agentId)
    if (snapshot !== undefined) {
      this.#publish(thread, agentId, snapshot)
    }
  }
  #fire(key: string): void {
    for (const listener of this.#listeners.get(key) ?? []) {
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
