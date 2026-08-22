import type {
  AgentSessionPort,
  ApprovalAnswer,
  ApprovalScope,
  FrameCursor,
  FramePage,
  PromptAsset,
  PromptConfiguration,
  PromptSkill,
  RunEvent,
  ThreadHistory,
} from '@poietica/agent-contract'
import type { TimelineState } from '../timeline'
import {
  appendLocalError,
  appendUserMessage,
  applyRunEvents,
  confirmRunCancellation,
  createTimelineState,
  opensTurn,
  prependThreadEvents,
  rejectRunCancellation,
  replayThreadEvents,
  requestRunCancellation,
  selectIsBusy,
} from '../timeline'
import { describeFailure } from './describe-failure'
import type { TranscriptSink } from './transcript-sink'

/*
 * 转录归这里，不归组件。
 *
 * 转录是后端状态：它来自本地帧日志的重放，加上一条实时帧流。这里是 React 官方
 * 为这件事给出的形状（useSyncExternalStore 的对侧）：一份按对话规范化的状态、
 * 一个订阅入口、以及唯一的写入方。
 *
 * 它是一个对象，形制与同一层的 ThreadsStore 一致。实例由组合根造出来、经 Context
 * 交下去（见 transcripts-context），所以「一个 store 订着一条线路」那道守卫是实例
 * 级而不是进程级的，测试也拿得到干净实例。held / alias / aliased / routes 本来就
 * 互相耦合（rename 同时写三张，forget 同时删三张），它们是一个对象的内部字段。
 *
 * 路由是一次查表，键是会话号：线路上每一帧都带着它（见 recorder.rs 的
 * RecordedEvent，每一种帧无一例外）。一条刚建出来的对话在开口之前没有会话号，
 * 它的号随 prompt 的答复回来，所以第一轮的帧一定跑在地址前面 —— 那一小段由
 * #unrouted 接着，地址一到整批折进去。许可窗口只有一个：有一次 prompt 在飞。
 */

/** 入口那一格的键前缀。它还不是一条对话，所以也没有什么可停的。 */
const DRAFT = 'draft:'

/**
 * 一句话只有图片时，这条对话叫什么。
 *
 * 与 apps/desktop/src-tauri/src/commands/agent/mod.rs 的 IMAGE_OPENER 逐字相同：
 * 那一处是权威（它写进库），这一处是它到达之前的乐观占位。两种语言共享不了
 * 一个常量，所以退而求其次 —— 只有一个地方定义规则，另一处标明自己是拷贝，
 * 并说得出正本在哪。
 */
const IMAGE_OPENER = '[图片]'

const NO_SESSION = '这个界面还没有接上助手会话，消息没有发送出去。'
const NO_THREAD = '无法开始新的对话，消息没有发送出去。'

/* 经过要不回来的两种说法。它们写进转录，因为人是在转录里找这段经过的。 */
const OTHER_AGENT = '这段对话由另一个 agent 保管，当前这个打不开它。'

const FORGOTTEN = 'agent 那侧已经没有这段会话，经过取不回来了。'

export interface Transcript {
  readonly timeline: TimelineState
  /** 还在把这条对话取回来。 */
  readonly restoring: boolean
  /** 取回来过。 */
  readonly loaded: boolean
  /** 这条对话是这个进程刚开出来的：没有它这里没有的东西，不必去取。 */
  readonly owned: boolean
  /** 更早那一页从哪儿接着读；null 就是前面没有了。 */
  readonly earlier: FrameCursor | null
  /** 正在往前读。 */
  readonly reading: boolean
}

/** 更早那一页从哪儿读回来。由组合根注入，所以这台 store 脱离进程可测。 */
export type EarlierFrames = (threadId: string, before: FrameCursor) => Promise<FramePage>

export interface TranscriptStoreOptions {
  /** 什么时候把「变了」告诉界面。 */
  readonly paint?: Paint
  /** 缺席就没有向上续读这条路：这台 store 不去猜谁能给它。 */
  readonly earlier?: EarlierFrames
}

export interface SendOptions {
  readonly port: AgentSessionPort | undefined
  /** 这一格现在的键：真对话 id，或入口那一格的草稿键。 */
  readonly key: string
  /** 这一格已经是哪条对话；入口那一格是 null。 */
  readonly endpoint: string | null
  readonly text: string
  /** 这一句带的图片，按它们在原生交付注册表里的位置点名。 */
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
  readonly identify?: (() => Promise<string | null>) | undefined
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
}

interface PendingSubmission {
  key: string
  readonly port: AgentSessionPort
  threadId: string | null
  cancelRequested: boolean
  cancelSent: boolean
}

/*
 * 没有这条对话时给出的那一份。
 *
 * 必须是同一个对象：useSyncExternalStore 用引用相等判断有没有变，每次新建一个
 * 会让它认为状态每帧都在变。
 */
const EMPTY: Transcript = {
  timeline: createTimelineState(),
  restoring: false,
  loaded: false,
  owned: false,
  earlier: null,
  reading: false,
}

/*
 * 本地的事故记在本地。
 *
 * 起不来的 agent、送不出去的权限答复、读不回来的历史，都发生在任何持久化之前
 * 或之外，日志里没有对应的帧。所以它们不伪造成帧：序号由原生那侧单调发放，本地
 * 借一个号出来，真的那一帧带着同一个号到达时就会被去重判成重复而永久丢掉 ——
 * 丢掉的可能正是 run_finished。
 */
function noteOn(timeline: TimelineState, cause: unknown, endsTurn: boolean): TimelineState {
  return appendLocalError(timeline, {
    message: describeFailure(cause),
    at: Date.now(),
    endsTurn,
  })
}

/*
 * 空白得说明来由。
 *
 * 一段取不回来的经过，和一条本来就没说过话的对话，在屏幕上是同一片空白，而它们
 * 不是同一件事：history 说清是哪一种，这里只把两种损失翻成一句人话，其余状态什
 * 么都不加。
 */
function lossOf(history: ThreadHistory): string | null {
  if (history.state !== 'unavailable') {
    return null
  }

  if (history.reason === 'otherAgent') {
    return history.owner === null
      ? OTHER_AGENT
      : `这段对话由 ${history.owner} 保管，当前 agent 打不开它。`
  }

  return FORGOTTEN
}

/**
 * 什么时候把「变了」告诉界面。
 */
export type Paint = (flush: () => void) => void

/**
 * 一拍最多等多久。
 *
 * 可见时 rAF 约一帧就到；隐藏之后它整个停摆，队列的上界由这个数持有。
 */
const FLUSH_CEILING_MS = 250

/*
 * 默认时基是画面，没有画面的地方（测试、SSR）退回微任务。
 *
 * rAF 在 document 隐藏时整个停摆（HTML 规范），而隐藏可以发生在这一拍约好之后 ——
 * 只挂 rAF，#pending 就会跟着一整轮回答无界增长。所以计时器与 rAF 赛跑，谁先到谁
 * 折，上界因此无条件成立；这与 main.tsx 呈现窗口用的是同一条赛跑。#flush 会把脏
 * 对话取空，后到的那个是空操作。
 */
const onNextPaint: Paint = (flush) => {
  if (typeof requestAnimationFrame !== 'function') {
    queueMicrotask(flush)

    return
  }

  let settled = false
  let frame: number | null = null
  let ceiling: ReturnType<typeof setTimeout>

  const finish = () => {
    if (settled) {
      return
    }

    settled = true
    clearTimeout(ceiling)

    if (frame !== null) {
      cancelAnimationFrame(frame)
    }

    flush()
  }

  ceiling = setTimeout(finish, FLUSH_CEILING_MS)
  frame = requestAnimationFrame(finish)
}

/* 谁都没在跑。引用固定，useSyncExternalStore 才判得出「没变」。 */
const NO_RUNNING: ReadonlySet<string> = new Set()

export class TranscriptStore implements TranscriptSink {
  readonly #paint: Paint

  /** 正在跑的那些对话。派生视图，唯一输入是每条转录的 timeline.status。 */
  #running: ReadonlySet<string> = NO_RUNNING

  #runningListeners = new Set<() => void>()

  /** 这一拍里变过的对话。同一条变一百次也只叫醒一次。 */
  #dirty = new Set<string>()

  #waiting = false

  readonly #earlier: EarlierFrames | undefined

  constructor({ earlier, paint = onNextPaint }: TranscriptStoreOptions = {}) {
    this.#paint = paint
    this.#earlier = earlier
  }

  /**
   * 对话 → 它的转录。这张表没有上限，也不需要有。
   *
   * 转录的生命周期就是对话的生命周期。回收因此只有一个出口：forget，由组合根在
   * 这条对话真的不存在时调用。
   */
  #held = new Map<string, Transcript>()

  #listeners = new Map<string, Set<() => void>>()

  /**
   * 草稿键 → 真对话 id。
   *
   * 入口那一格在说话之前不是任何一条对话，可它已经有转录了（人说的那句话）。
   * 乐观 id 对账是 store 的职责：这里给它一个别名，两个键读到同一份东西，界面
   * 拿到真 id 的那一帧因此没有任何空档。
   */
  #alias = new Map<string, string>()

  /** 真 id → 草稿键。alias 的反向索引：通知与淘汰都要按"谁在看"来问。 */
  #aliased = new Map<string, string>()

  #drafts = 0

  /**
   * 会话号 → 对话。归属只有这一张表。
   *
   * 它在打开一条对话时就写好了（route），而帧是此后才发生的事，所以查不到主人
   * 是一种真正的异常，不是一段要等的时差。一条会话跨越它上面的每一轮，这张表
   * 因此不随一轮结束而删；它的规模等于这个进程打开过几条对话，与 ThreadsStore
   * 的 #sessions 同阶。
   */
  #routes = new Map<string, string>()

  /**
   * 地址还没到、先到了的帧，按会话攒着。
   *
   * 会话号由原生侧在 prompt 的答复里给出，所以一条新对话第一轮的帧必然跑在地址
   * 前面。攒着只在有一次 prompt 在飞时成立，地址一到就整批折进去。
   */
  #unrouted = new Map<string, RunEvent[]>()

  /** 此刻有几次 prompt 在飞。它是「帧可以跑在地址前面」这条许可的唯一依据。 */
  #opening = 0

  #submissions = new Map<string, PendingSubmission>()

  /**
   * 收到了、还没折进转录的帧，按对话攒着。
   *
   * 每折一帧要复制一遍整条 items（见 timeline-draft 的 draftOf）。所以帧先攒，
   * 折叠推迟到真的有人要看的那一刻：下一拍，或者任何一次同步读。
   */
  #pending = new Map<string, RunEvent[]>()

  /**
   * 读回来了、还对不齐一轮起点的那些帧，按对话攒着。
   *
   * 页按帧数切，而轮次的边界在帧里（run_started）。一页的开头因此常常是半截
   * 轮次：它的提问在更早那一页。攒着不投影，等更早那一页的起点到达再一起折
   * 进去 —— 与 #pending 同性质：未投影的输入，不是第二份真相。
   */
  #unaligned = new Map<string, RunEvent[]>()

  #attachedTo: AgentSessionPort | null = null

  #detach: (() => void) | null = null

  /** 入口那一格的键。 */
  newDraft = (): string => {
    this.#drafts += 1

    return `${DRAFT}${String(this.#drafts)}`
  }

  /**
   * 这一格现在是什么样子。一次查表，什么都不改。
   *
   * 这就是 useSyncExternalStore 的 getSnapshot，React 在渲染期调用它，契约要求
   * 它是纯读取。折叠因此只剩两个位置，都在读之外：#flush（叫醒订阅者之前折完）
   * 与 #now（写路径要的是最新那一份，而写路径本来就在改状态）。
   *
   * 帧进 → 折叠 → 通知 → 读，单向，不回头。
   */
  read = (key: string): Transcript => this.#held.get(this.#resolveKey(key)) ?? EMPTY

  subscribe = (key: string, listener: () => void): (() => void) => {
    const set = this.#listeners.get(key) ?? new Set<() => void>()

    set.add(listener)
    this.#listeners.set(key, set)

    return () => {
      set.delete(listener)

      if (set.size === 0) {
        this.#listeners.delete(key)
      }
    }
  }

  /**
   * 正在跑的那些对话。侧栏与标签条读的是同一份。
   *
   * 判据只有 selectIsBusy 一处，输入只有转录本身 —— 没有第二份「谁在跑」的
   * 状态，也就没有可以和真相脱节的缓存。
   */
  runningSnapshot = (): ReadonlySet<string> => this.#running

  subscribeRunning = (listener: () => void): (() => void) => {
    this.#runningListeners.add(listener)

    return () => {
      this.#runningListeners.delete(listener)
    }
  }

  /**
   * 这条会话属于这条对话。
   *
   * 由握着这个事实的那一方交过来（SessionControlsStore 在打开的答复里拿到
   * 它），所以这里不猜也不问。同一条会话重复登记是幂等的。
   */
  route = (sessionId: string, key: string): void => {
    this.#routes.set(sessionId, key)

    const held = this.#unrouted.get(sessionId)

    if (held !== undefined) {
      this.#unrouted.delete(sessionId)
      this.#queue(key, held)
    }
  }

  /**
   * 这条对话不存在了。
   *
   * 这是转录唯一的回收出口：转录的生命周期就是对话的生命周期。
   *
   * 攒着还没折进去的帧也在这里作废。漏掉它们不只是漏一格内存 —— 删掉一条正在
   * 流式输出的对话之后，界面被叫醒、read 走到 #settle，那批帧会被折进一个空
   * 转录再写回 #held，被删掉的东西就这么回到了屏幕上。
   *
   * 删完就通知：还挂着的界面下一帧读到的是 EMPTY，不是一份不存在的东西。
   */
  forget = (key: string): void => {
    const real = this.#resolveKey(key)
    const draft = this.#aliased.get(real)

    this.#releaseSubmission(real)
    this.#held.delete(real)
    this.#pending.delete(real)
    this.#unaligned.delete(real)
    this.#aliased.delete(real)
    this.#dirty.delete(real)

    if (draft !== undefined) {
      this.#alias.delete(draft)
    }

    /* 会话号那张表也是按对话记的：留着它，死会话的帧仍会找到主人。 */
    for (const [sessionId, owner] of this.#routes) {
      if (owner === real) {
        this.#routes.delete(sessionId)
        this.#unrouted.delete(sessionId)
      }
    }

    this.#fire(real)

    if (draft !== undefined) {
      this.#fire(draft)
    }

    this.#republish()
  }

  /* ================= 一段历史送到 ================= */

  /**
   * 接上帧流。
   *
   * 只剩这一件事了。历史随「打开这条对话」一起回来，来源是本地帧日志（见
   * thread.rs）—— 那正是当时交给界面的同一批帧。agent 那侧那份是模型的上下文，
   * 由 session/load 让它自己恢复，不参与投影。
   */
  ensure = (port: AgentSessionPort): void => {
    this.#attach(port)
  }

  /** 正在把这条对话要回来。 */
  opening = (threadId: string): void => {
    const current = this.#now(threadId)

    if (current.owned || current.loaded) {
      return
    }

    this.#put(threadId, { ...current, restoring: true })
  }

  /**
   * 最新那一页经过到了。
   *
   * 帧在这里从 unknown 收窄成 RunEvent，全程只有这一处，而且在明处：形状由
   * frame.rs 定义，重放的帧与实时的帧走同一条重放函数。
   *
   * 一页可以是空的，为什么空由 history 说明。两种损失走本地事故那条既有通道，
   * endsTurn 为假 —— 不是某一轮失败了，是这段经过没回来。
   */
  adopt = (threadId: string, page: FramePage, history: ThreadHistory): void => {
    /* 经过由本地日志重放：段边界与每一轮的两端都在帧里（run_started 与终帧
       各带自己的时刻），所以这里不再有第二把尺子。图仍来自本机账本。 */
    const replayed = replayThreadEvents(page.events as readonly RunEvent[])
    const lost = lossOf(history)

    this.#put(threadId, {
      timeline: lost === null ? replayed : noteOn(replayed, lost, false),
      restoring: false,
      loaded: true,
      owned: false,
      earlier: page.before,
      reading: false,
    })
  }

  /** 要不回来。这一条记在转录里，而不是记在会话设置那一格上。 */
  failed = (threadId: string, cause: unknown): void => {
    const latest = this.#now(threadId)

    this.#put(threadId, {
      ...latest,
      restoring: false,
      timeline: noteOn(latest.timeline, cause, false),
    })
  }

  /**
   * 人滚到了顶。
   *
   * 滚动区只上报这一件事：它不知道有没有更早的、也不该知道读一页要读几趟。
   * 反复上报是幂等的 —— 正在读、或者前面没有了，都当场返回。
   */
  reachedTop = (key: string): void => {
    void this.#readEarlier(this.#resolveKey(key))
  }

  /* ================= 内部 ================= */

  /**
   * 往前读，一次读到一个轮次起点为止。
   *
   * 一页读回来可能整页都没有 run_started（一轮长过一页），那就接着往前读；
   * 攒下的半截帧留在 #unaligned，等起点到达再一起折进去。游标为 null 时前面
   * 没有了，攒下的那一批就是最早那一轮，整批折进去。
   */
  async #readEarlier(real: string): Promise<void> {
    const read = this.#earlier
    const current = this.#now(real)

    if (read === undefined || current.reading || current.earlier === null) {
      return
    }

    this.#put(real, { ...current, reading: true })

    let cursor: FrameCursor | null = current.earlier

    try {
      while (cursor !== null) {
        const page: FramePage = await read(real, cursor)
        const merged = [
          ...(page.events as readonly RunEvent[]),
          ...(this.#unaligned.get(real) ?? []),
        ]
        const at = merged.findIndex(opensTurn)

        cursor = page.before

        if (cursor === null) {
          this.#unaligned.delete(real)
          this.#prepend(real, merged, null)

          return
        }

        if (at < 0) {
          this.#unaligned.set(real, merged)
          continue
        }

        this.#unaligned.set(real, merged.slice(0, at))
        this.#prepend(real, merged.slice(at), cursor)

        return
      }
    } catch (cause: unknown) {
      const latest = this.#now(real)

      this.#put(real, {
        ...latest,
        reading: false,
        timeline: noteOn(latest.timeline, cause, false),
      })
    }
  }

  /** 一批对齐好的更早帧，一次折进去。 */
  #prepend(real: string, events: readonly RunEvent[], earlier: FrameCursor | null): void {
    const latest = this.#now(real)

    this.#put(real, {
      ...latest,
      timeline: prependThreadEvents(latest.timeline, events),
      earlier,
      reading: false,
    })
  }

  /* ================= 说一句话 ================= */

  send = ({
    assets,
    configuration,
    endpoint,
    identify,
    key,
    onUserMessage,
    port,
    skills,
    text,
  }: SendOptions): void => {
    const at = Date.now()
    const current = this.#now(key)

    /* 人说的那句话先上屏，再去问 agent。失败的一轮丢掉的是答案，不是问题。
       图这一刻还没有地址：字节要先落盘。它随这一轮的 run_started 帧回来，所以
       实时那条路与重开对话那条路走的是同一条（见 projection.ts 的 withPrompt）。 */
    const opened = appendUserMessage(current.timeline, text, at, assets.length)

    this.#put(key, { ...current, timeline: opened })

    if (port === undefined) {
      this.#fail(key, new Error(NO_SESSION))

      return
    }

    this.#attach(port)

    const real = this.#resolveKey(key)
    this.#releaseSubmission(real)

    const submission: PendingSubmission = {
      key: real,
      port,
      threadId: endpoint,
      cancelRequested: false,
      cancelSent: false,
    }

    this.#submissions.set(real, submission)

    const conversation =
      endpoint === null ? (identify?.() ?? Promise.resolve(null)) : Promise.resolve(endpoint)

    this.#opening += 1

    void conversation
      .then((threadId) => {
        if (threadId === null) {
          this.#releaseSubmission(submission)
          this.#fail(key, new Error(NO_THREAD))

          return undefined
        }

        /* 草稿在这一刻成为一条真对话：同一份转录，换一个名字。 */
        if (threadId !== key) {
          this.#rename(key, threadId)
        }

        submission.threadId = threadId

        if (submission.cancelRequested) {
          this.#cancelUnsubmitted(submission)
          this.#releaseSubmission(submission)

          return undefined
        }

        /*
         * 用来命名的那句话，不一定就是发出去的那句话：一句话可以只有图片，
         * 而库那侧对它的名字早有答案（IMAGE_OPENER）。
         *
         * trim 与那一侧同步：它收到的 text 是 trim 过的，空白判据必须一致，
         * 否则一句只有空格加一张图的话会在两边得到两个名字。
         */
        onUserMessage?.(threadId, text.trim() === '' && assets.length > 0 ? IMAGE_OPENER : text)

        return port.prompt({ threadId, text, assets, configuration, skills }).then((handle) => {
          this.route(handle.sessionId, threadId)

          if (submission.cancelRequested) {
            this.#sendCancellation(submission)
          }
        })
      })
      .catch((cause: unknown) => {
        /* 没有"当前那一轮"要收拾了：这一轮从来没拿到过地址，也就从来没占过谁。 */
        this.#fail(key, cause)
      })
      .finally(() => {
        this.#opening -= 1

        /* 一次 prompt 都不在飞了：还没认领的那些帧不会再有地址。 */
        if (this.#opening === 0) {
          this.#unrouted.clear()
        }
      })
  }

  cancel = (key: string): void => {
    const threadId = this.#resolveKey(key)
    const port = this.#attachedTo

    if (port === null) {
      return
    }

    let submission = this.#submissions.get(threadId)

    if (submission === undefined) {
      if (threadId.startsWith(DRAFT)) {
        return
      }

      submission = {
        key: threadId,
        port,
        threadId,
        cancelRequested: false,
        cancelSent: false,
      }
      this.#submissions.set(threadId, submission)
    }

    this.#requestCancellation(submission)
  }

  #requestCancellation(submission: PendingSubmission): void {
    if (submission.cancelRequested) {
      return
    }

    submission.cancelRequested = true
    const current = this.#now(submission.key)

    this.#put(submission.key, {
      ...current,
      timeline: requestRunCancellation(current.timeline),
    })

    if (submission.threadId === null) {
      /* 没有地址可等：入口那一格的取消即刻落定。 */
      this.#cancelUnsubmitted(submission)

      return
    }

    this.#sendCancellation(submission)
  }

  #sendCancellation(submission: PendingSubmission): void {
    const threadId = submission.threadId

    if (threadId === null || submission.cancelSent) {
      return
    }

    submission.cancelSent = true

    try {
      void Promise.resolve(submission.port.cancel(threadId)).then(
        () => {},
        (cause: unknown) => {
          submission.cancelSent = false
          this.note(submission.key, describeFailure(cause))
          this.#rejectCancellation(submission)
        },
      )
    } catch (cause) {
      submission.cancelSent = false
      this.note(submission.key, describeFailure(cause))
      this.#rejectCancellation(submission)
    }
  }

  #cancelUnsubmitted(submission: PendingSubmission): void {
    const current = this.#now(submission.key)

    this.#put(submission.key, {
      ...current,
      timeline: confirmRunCancellation(current.timeline, Date.now()),
    })
  }

  #rejectCancellation(submission: PendingSubmission): void {
    submission.cancelRequested = false
    this.#releaseSubmission(submission)

    const current = this.#now(submission.key)

    this.#put(submission.key, {
      ...current,
      timeline: rejectRunCancellation(current.timeline),
    })
  }

  #releaseSubmission(target: string | PendingSubmission): void {
    const submission = typeof target === 'string' ? this.#submissions.get(target) : target

    if (submission === undefined || this.#submissions.get(submission.key) !== submission) {
      return
    }

    this.#submissions.delete(submission.key)
  }

  /* 线路只有一条（#attachedTo），答复的地址不必由调用方再交一次 —— 与 cancel 同一个入口。 */
  resolvePermission = (
    key: string,
    requestId: string,
    decision: ApprovalAnswer,
    scope?: ApprovalScope,
  ): void => {
    const port = this.#attachedTo

    if (port === null) {
      return
    }

    port.resolvePermission(requestId, decision, scope).catch((cause: unknown) => {
      this.note(key, describeFailure(cause))
    })
  }

  /**
   * 一件本地事故，记进这条对话的转录。
   *
   * 它是本地事故唯一的公开入口：界面层此前把「连不上 agent」画在输入框顶上,
   * 那是第二条报错通道 —— 同一类事实按它从哪儿来决定长什么样。报错只有一种
   * 形态,就是转录里的那一条横线。
   *
   * endsTurn 为假：这不是某一轮失败了。同一句话不重复记 —— 一次连接失败会随
   * 渲染反复交进来。
   */
  note = (key: string, message: string): void => {
    const current = this.#now(key)
    const tail = current.timeline.items.at(-1)

    if (tail?.type === 'error' && tail.message === message) {
      return
    }

    this.#put(key, {
      ...current,
      timeline: appendLocalError(current.timeline, { message, at: Date.now(), endsTurn: false }),
    })
  }

  /* ================= 内部 ================= */

  #resolveKey(key: string): string {
    return this.#alias.get(key) ?? key
  }

  /*
   * 写路径要的那一份：先把攒着的帧折进去，再拿。
   *
   * 与 read 分开，是因为它们问的不是同一件事。read 问「订阅者此刻看到的是
   * 什么」，答案必须是已提交的状态；这里问「我要往上面追加，基线是什么」，
   * 答案必须把在途的帧算进去。同一个函数同时回答两者，就是让快照读取带上
   * 副作用。
   */
  #now(key: string): Transcript {
    return this.#settle(this.#resolveKey(key))
  }

  #fire(key: string): void {
    /* 没人听就是没人听：?? [] 会为每一帧白建一个空数组，而 #put 一帧调一次。 */
    const set = this.#listeners.get(key)

    if (set === undefined) {
      return
    }

    for (const listener of set) {
      listener()
    }
  }

  /*
   * 「谁在跑」变了就换一份，没变连引用都不换。
   *
   * 两个出口在这里汇合：折叠落定（#flush）与对话作废（forget）。整表重扫而不
   * 增量维护 —— 规模等于这个进程打开过几条对话，而增量要在改名与作废两处各记
   * 一笔，那两笔正是会漏的地方。草稿键不是对话 id，不进这张表。
   */
  #republish(): void {
    const running = new Set<string>()

    for (const [key, transcript] of this.#held) {
      if (!key.startsWith(DRAFT) && selectIsBusy(transcript.timeline)) {
        running.add(key)
      }
    }

    if (
      running.size === this.#running.size &&
      [...running].every((key) => this.#running.has(key))
    ) {
      return
    }

    this.#running = running

    for (const listener of this.#runningListeners) {
      listener()
    }
  }

  /*
   * 变了就记下，一拍发一次。
   *
   * 写入是同步的，叫醒不是：帧以毫秒计到达，而屏幕只按帧率重画。
   */
  #notify(real: string): void {
    this.#dirty.add(real)

    if (this.#waiting) {
      return
    }

    this.#waiting = true
    this.#paint(this.#flush)
  }

  /*
   * 这一拍攒下的变化，一次交出去。
   *
   * 通知走反向索引（#aliased）：按草稿键找真 id 是一次查表，不是一次线性扫描。
   */
  #flush = (): void => {
    this.#waiting = false

    const dirty = this.#dirty

    this.#dirty = new Set<string>()

    for (const real of dirty) {
      this.#settle(real)
      this.#fire(real)

      const draft = this.#aliased.get(real)

      if (draft !== undefined) {
        this.#fire(draft)
      }
    }

    this.#republish()
  }

  #put(key: string, next: Transcript): void {
    /* 一次解析，一次叫醒：这里是叫醒的两个入口之一，另一个是 #queue。 */
    const real = this.#resolveKey(key)

    this.#write(real, next)
    this.#notify(real)
  }

  /*
   * 写下来，不惊动任何人。
   *
   * 「写」与「叫醒」是两件事：叫醒由两个入口负责 —— 收到帧的那一刻（#queue）与
   * 外部写入的那一刻（#put）—— 折叠只管把状态改对。焊在一起的话，「把攒下的帧
   * 折进去」这个动作本身也会再约一拍，而那一拍没有任何新东西可看。
   */
  #write(real: string, next: Transcript): void {
    this.#held.set(real, next)
  }

  /*
   * 草稿成为一条真对话：同一份转录，换一个名字。
   *
   * 走 #put，不直接写 #held：换身份也是一次写入，订阅者必须被叫醒 ——
   * useSyncExternalStore 的契约要的就是这个。
   */
  #rename(from: string, to: string): void {
    const submission = this.#submissions.get(from)

    if (submission !== undefined) {
      this.#submissions.delete(from)
      submission.key = to
      submission.threadId = to
      this.#submissions.set(to, submission)
    }

    this.#alias.set(from, to)
    this.#aliased.set(to, from)

    const drafted = this.#held.get(from)

    if (drafted === undefined) {
      return
    }

    this.#held.delete(from)
    this.#put(to, { ...drafted, owned: true })
  }

  /** 这一句问不出去，或者半路断了：这一轮到此为止。 */
  #fail(key: string, cause: unknown): void {
    const current = this.#now(key)

    this.#put(key, { ...current, timeline: noteOn(current.timeline, cause, true) })
  }

  /*
   * 攒下这一批，并说一声「这条对话变了」。
   *
   * 一批只属于一条会话，所以解析键、查队列、记脏对整批各做一次就够，而不是
   * 随帧数重复。说的是「变了」，不是「现在长这样」：状态要到有人看的那一刻
   * 才折出来。
   */
  #queue(owner: string, events: readonly RunEvent[]): void {
    const real = this.#resolveKey(owner)
    const waiting = this.#pending.get(real)

    if (waiting === undefined) {
      this.#pending.set(real, [...events])
    } else {
      for (const event of events) {
        waiting.push(event)
      }
    }

    this.#notify(real)
  }

  /*
   * 攒下的这一批，一趟折进去。
   *
   * 一批一份草稿、一次复制、一次封版（见 applyRunEvents）。全是重复帧时它原样
   * 交回旧对象，那就什么都没发生过：引用不变，下游的记忆化不被打掉。
   */
  #settle(real: string): Transcript {
    const waiting = this.#pending.get(real)
    const current = this.#held.get(real) ?? EMPTY

    if (waiting === undefined) {
      return current
    }

    this.#pending.delete(real)

    const terminal = waiting.some(
      (event) => event.kind === 'run_finished' || event.kind === 'run_failed',
    )
    const submission = this.#submissions.get(real)
    let timeline = applyRunEvents(current.timeline, waiting)

    if (terminal) {
      this.#releaseSubmission(real)
    } else if (submission?.cancelRequested === true) {
      timeline = requestRunCancellation(timeline)
    }

    if (timeline === current.timeline) {
      return current
    }

    this.#write(real, { ...current, timeline })

    return this.#held.get(real) ?? EMPTY
  }

  /*
   * 一批帧到了，交给它们的主人。整批共一个地址（见端口的 subscribe）。
   *
   * 地址还没到就攒着，等 route 认领：新对话第一轮的会话号随 prompt 的答复才回来，
   * 而那一轮的帧比答复早。有一次 prompt 在飞是攒的许可；一次都没有时的无主帧是真
   * 的无主 —— 这条会话不是这一侧开的。
   */
  #route(events: readonly RunEvent[], sessionId: string): void {
    const owner = this.#routes.get(sessionId)

    if (owner !== undefined) {
      this.#queue(owner, events)

      return
    }

    if (this.#opening === 0) {
      return
    }

    const held = this.#unrouted.get(sessionId)

    if (held === undefined) {
      this.#unrouted.set(sessionId, [...events])

      return
    }

    for (const event of events) {
      held.push(event)
    }
  }

  /* 一个 store 订着一条线路。 */
  #attach(port: AgentSessionPort): void {
    if (this.#attachedTo === port) {
      return
    }

    this.#detach?.()
    this.#attachedTo = port
    this.#detach = port.subscribe((events, sessionId) => {
      this.#route(events, sessionId)
    })
  }
}
