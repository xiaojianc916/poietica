import type {
  AgentSessionPort,
  ApprovalAnswer,
  FrameCursor,
  FramePage,
  PromptAsset,
  PromptConfiguration,
  PromptSkill,
  RunEvent,
  RunStatus,
  ThreadHistory,
  TurnMark,
} from '../agent'
import type { TimelineState } from '../timeline'
import {
  appendLocalError,
  appendUserMessage,
  applyRunEvents,
  confirmRunCancellation,
  createTimelineState,
  delegateKey,
  endsRun,
  isDelegateKey,
  isSteerable,
  opensTurn,
  partitionByAgent,
  prependThreadEvents,
  rejectRunCancellation,
  replayRunEvents,
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
 * RecordedEvent，每一种帧无一例外）。会话号随 prompt 的答复或打开的答复回来，
 * 两条路都慢于帧，所以那一小段由 #unrouted 有界地接着，地址一到整批折进去。
 */

/**
 * 一句话只有图片时，这条对话叫什么。
 *
 * 与 apps/desktop/src-tauri/src/ipc/commands/conversation/mod.rs 的
 * IMAGE_OPENER 逐字相同：
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
  /** 这条对话的整本目录，一轮一行。定义域是帧日志，不是此刻载入了多少。 */
  readonly outline: readonly TurnMark[]
  /** 正在往前读。 */
  readonly reading: boolean
  /** 目录跳转正在补载的轮次；普通分页或空闲时为 null。 */
  readonly revealing: string | null
}

/** 帧日志的有界分页与目录读取。由组合根注入，所以 store 脱离进程可测。 */
export interface TranscriptReads {
  readonly earlier: (threadId: string, before: FrameCursor) => Promise<FramePage>
  readonly outline: (threadId: string, fromSeq: number | null) => Promise<readonly TurnMark[]>
}

export interface TranscriptStoreOptions {
  /** 什么时候把「变了」告诉界面。 */
  readonly paint?: Paint
  /** 缺席就没有向上读这条路：这台 store 不去猜谁能给它。 */
  readonly reads?: TranscriptReads
}

export interface SendOptions {
  readonly port: AgentSessionPort | undefined
  readonly threadId: string
  readonly text: string
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
  readonly prepare?: (() => Promise<boolean>) | undefined
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
}

interface PendingSubmission {
  readonly key: string
  readonly port: AgentSessionPort
  readonly threadId: string
  ready: boolean
  cancelRequested: boolean
  cancelSent: boolean
}

interface HistoryLoad {
  readonly targets: Map<string, TurnMark>
  promise: Promise<void>
}

interface OutlineLoad {
  stale: boolean
  promise: Promise<void>
}

function mergeOutline(
  current: readonly TurnMark[],
  suffix: readonly TurnMark[],
  fromSeq: number | null,
): readonly TurnMark[] {
  if (fromSeq === null) {
    return suffix
  }
  const boundary = current.findIndex((mark) => mark.at.seq === fromSeq)
  if (boundary < 0) {
    throw new Error('目录增量游标不在当前目录中。')
  }
  return [...current.slice(0, boundary), ...suffix]
}

/* 引用固定，useSyncExternalStore 才判得出「没变」。 */
const NO_MARKS: readonly TurnMark[] = []

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
  outline: NO_MARKS,
  reading: false,
  revealing: null,
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

/**
 * 常驻转录的上限。
 *
 * 转录可由 adopt 从帧日志重建，所以没人在看、没在跑的那些留着换不到东西 ——
 * 而 #republish 每一拍要走一遍这张表，表越长每一帧越贵。
 */
const HELD_CEILING = 64

/**
 * 地址还没到时，一条会话最多攒多少帧、最多攒几条会话。
 *
 * 帧已经落进本机帧日志（run_events），攒着只为不让屏幕缺一段。攒不下就丢最旧的
 * 那一条会话：重开这条对话会从日志里重放回来，而无界地攒会让一条永远认不到主人
 * 的会话把内存吃光。
 */
const UNROUTED_FRAME_CEILING = 512

const UNROUTED_SESSION_CEILING = 32

export class TranscriptStore implements TranscriptSink {
  readonly #paint: Paint

  /** 正在跑的那些对话。派生视图，唯一输入是每条转录的 timeline.status。 */
  #running: ReadonlySet<string> = NO_RUNNING

  #runningListeners = new Set<() => void>()

  /** 这一拍里变过的对话。同一条变一百次也只叫醒一次。 */
  #dirty = new Set<string>()

  #waiting = false

  readonly #reads: TranscriptReads | undefined

  /** 每条对话至多一个历史读取；目标可在读取期间追加。 */
  #historyLoads = new Map<string, HistoryLoad>()

  /** 每条对话至多一个目录读取；在途失效只追读一次最新后缀。 */
  #outlineLoads = new Map<string, OutlineLoad>()

  constructor({ reads, paint = onNextPaint }: TranscriptStoreOptions = {}) {
    this.#paint = paint
    this.#reads = reads
  }

  /**
   * 对话 → 它的转录。插入序即 LRU 序，上限由 #trim 持有。
   *
   * 回收只有一条路径（#evict）：组合根说这条对话不存在了，或者它排到了表头而
   * 没有人在看。
   */
  #held = new Map<string, Transcript>()

  #listeners = new Map<string, Set<() => void>>()

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
   * 会话号随 prompt 的答复（新对话）或打开的答复（重开一条还在跑的对话）回来，
   * 两者都慢于帧。上界由 UNROUTED_* 两个数持有，地址一到就整批折进去。
   */
  #unrouted = new Map<string, RunEvent[]>()

  #submissions = new Map<string, PendingSubmission>()

  /**
   * 收到了、还没折进转录的帧，按对话攒着。
   *
   * 每折一帧要复制一遍整条 items（见 timeline-draft 的 draftOf）。所以帧先攒，
   * 折叠推迟到真的有人要看的那一刻：下一拍，或者任何一次同步读。
   */
  #pending = new Map<string, RunEvent[]>()

  #attachedTo: AgentSessionPort | null = null

  #detach: (() => void) | null = null

  /**
   * 这一格现在是什么样子。一次查表，什么都不改。
   *
   * 这就是 useSyncExternalStore 的 getSnapshot，React 在渲染期调用它，契约要求
   * 它是纯读取。折叠因此只剩两个位置，都在读之外：#flush（叫醒订阅者之前折完）
   * 与 #now（写路径要的是最新那一份，而写路径本来就在改状态）。
   *
   * 帧进 → 折叠 → 通知 → 读，单向，不回头。
   */
  read = (key: string): Transcript => this.#held.get(key) ?? EMPTY

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

  waitForTerminal = (
    key: string,
  ): Promise<Extract<RunStatus, 'completed' | 'cancelled' | 'failed'>> => {
    type Terminal = Extract<RunStatus, 'completed' | 'cancelled' | 'failed'>
    const terminalOf = (status: RunStatus): Terminal | null =>
      status === 'completed' || status === 'cancelled' || status === 'failed' ? status : null
    const ready = terminalOf(this.read(key).timeline.status)

    if (ready !== null) {
      return Promise.resolve(ready)
    }

    return new Promise<Terminal>((resolve) => {
      let off = () => {}
      let seen = false
      const finish = (terminal: Terminal) => {
        off()
        resolve(terminal)
      }
      const settle = () => {
        const terminal = terminalOf(this.read(key).timeline.status)
        if (terminal !== null) {
          finish(terminal)

          return
        }

        const alive = this.#held.has(key)

        /* 这条对话已经作废（forget）：它不会再有终局帧，等下去就是永远等。 */
        if (seen && !alive) {
          finish('cancelled')

          return
        }

        seen = seen || alive
      }

      off = this.subscribe(key, settle)
      settle()
    })
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

  ownerOf = (sessionId: string): string | undefined => this.#routes.get(sessionId)

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
    this.#evict(key)
    this.#fire(key)
    this.#republish()
  }

  #evict(key: string): void {
    this.#releaseSubmission(key)
    this.#historyLoads.delete(key)
    this.#outlineLoads.delete(key)
    this.#held.delete(key)
    this.#pending.delete(key)
    this.#dirty.delete(key)

    const prefix = delegateKey(key, '')
    for (const held of this.#held.keys()) {
      if (held.startsWith(prefix)) {
        this.#held.delete(held)
        this.#pending.delete(held)
        this.#dirty.delete(held)
        this.#fire(held)
      }
    }

    for (const [sessionId, owner] of this.#routes) {
      if (owner === key) {
        this.#routes.delete(sessionId)
        this.#unrouted.delete(sessionId)
      }
    }
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
    /* The bounded snapshot owns the interactive read lane; the full outline follows. */
    queueMicrotask(() => {
      void this.#readOutline(threadId)
    })
  }

  /**
   * 最新那一页经过到了。
   *
   * 到这一层的帧已经是 RunEvent：线上原文的收窄发生在桥（native-bridge 的
   * gateways/agent.ts），形状由 frame.rs 定义，重放的帧与实时的帧走同一条
   * 重放函数。
   *
   * 一页可以是空的，为什么空由 history 说明。两种损失走本地事故那条既有通道，
   * endsTurn 为假 —— 不是某一轮失败了，是这段经过没回来。
   */
  adopt = (threadId: string, page: FramePage): void => {
    const current = this.#now(threadId)
    /* 已经持有这条对话：帧流维持着最新那一页，重放它会丢掉向上读回来的那些页。但游标
       必须收下 —— 它是「上面还有没有」的唯一答案，丢了它这条对话再也翻不到更早。 */
    if (current.owned || current.loaded) {
      const earlier = current.earlier ?? page.before

      if (!current.restoring && current.loaded && current.earlier === earlier) {
        return
      }

      this.#put(threadId, {
        ...current,
        earlier,
        loaded: true,
        restoring: false,
        timeline: current.timeline,
      })

      return
    }

    /* 后端交回的历史页已经按完整轮次对齐，并把连续 delta 压成 block。 */
    const split = partitionByAgent(page.events)

    for (const [agentId, channel] of split.channels) {
      const key = delegateKey(threadId, agentId)

      if (!this.#held.has(key)) {
        this.#put(key, { ...EMPTY, timeline: replayRunEvents(channel), loaded: true })
      }
    }

    this.#put(threadId, {
      timeline: replayThreadEvents(split.main),
      restoring: false,
      loaded: true,
      owned: false,
      earlier: page.before,
      outline: this.#now(threadId).outline,
      reading: false,
      revealing: null,
    })
  }

  history = (threadId: string, history: ThreadHistory): void => {
    const message = lossOf(history)
    if (message !== null) {
      this.note(threadId, message)
    }
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

  /* ================= 内部 ================= */

  /** 向上读一页；目录跳转也只使用这一个有界分页原语。 */
  readEarlier = (key: string): Promise<void> => this.#readHistory(key)

  revealTurn = (key: string, mark: TurnMark): Promise<void> => this.#readHistory(key, mark)

  #readHistory(real: string, target?: TurnMark): Promise<void> {
    const reads = this.#reads
    const opened = this.#now(real)

    if (reads === undefined || opened.earlier === null) {
      return Promise.resolve()
    }

    const running = this.#historyLoads.get(real)

    if (running !== undefined) {
      if (target !== undefined) {
        const latest = this.#now(real)
        if (!this.#hasTimelineItem(latest.timeline, target.admissionId)) {
          running.targets.set(target.admissionId, target)
          if (latest.revealing !== target.admissionId) {
            this.#put(real, { ...latest, revealing: target.admissionId })
          }
        }
      }

      return running.promise
    }

    const targets = new Map<string, TurnMark>()
    if (target !== undefined && !this.#hasTimelineItem(opened.timeline, target.admissionId)) {
      targets.set(target.admissionId, target)
    }
    if (target !== undefined && targets.size === 0) {
      return Promise.resolve()
    }

    const load: HistoryLoad = { targets, promise: Promise.resolve() }
    this.#historyLoads.set(real, load)
    this.#put(real, {
      ...opened,
      reading: true,
      revealing: target?.admissionId ?? null,
    })

    load.promise = this.#runHistoryLoad(real, load, target === undefined)
      .catch((cause: unknown) => {
        if (this.#historyLoads.get(real) !== load || !this.#held.has(real)) {
          return
        }
        const latest = this.#now(real)
        this.#put(real, { ...latest, timeline: noteOn(latest.timeline, cause, false) })
      })
      .finally(() => {
        if (this.#historyLoads.get(real) !== load) {
          return
        }
        this.#historyLoads.delete(real)
        if (this.#held.has(real)) {
          this.#put(real, { ...this.#now(real), reading: false, revealing: null })
        }
      })

    return load.promise
  }

  async #runHistoryLoad(real: string, load: HistoryLoad, onePage: boolean): Promise<void> {
    const reads = this.#reads
    if (reads === undefined) {
      return
    }
    let pages = onePage ? 1 : 0

    while (this.#isHistoryLoadActive(real, load)) {
      const current = this.#now(real)
      this.#dropLoadedTargets(load, current.timeline)
      if (pages === 0 && load.targets.size === 0) {
        return
      }
      const before = current.earlier
      if (before === null) {
        if (load.targets.size > 0) {
          throw new Error('目录指向的轮次不在历史中。')
        }
        return
      }

      const page = await reads.earlier(real, before)
      if (!this.#isHistoryLoadActive(real, load)) {
        return
      }

      this.#prepend(real, page.events, page.before)
      this.#dropPageTargets(load, page.events)
      pages = Math.max(0, pages - 1)

      if (pages === 0 && load.targets.size === 0) {
        return
      }
      this.#assertCursorAdvanced(before, page.before)
    }
  }

  #isHistoryLoadActive(real: string, load: HistoryLoad): boolean {
    return this.#historyLoads.get(real) === load && this.#held.has(real)
  }

  #assertCursorAdvanced(previous: FrameCursor, next: FrameCursor | null): void {
    if (next === null) {
      throw new Error('目录指向的轮次不在历史中。')
    }
    if (next.sessionId === previous.sessionId && next.seq === previous.seq) {
      throw new Error('历史分页游标没有前进。')
    }
  }

  #dropLoadedTargets(load: HistoryLoad, timeline: TimelineState): void {
    for (const admissionId of load.targets.keys()) {
      if (this.#hasTimelineItem(timeline, admissionId)) {
        load.targets.delete(admissionId)
      }
    }
  }

  #dropPageTargets(load: HistoryLoad, events: readonly RunEvent[]): void {
    for (const event of events) {
      if (event.kind !== 'prompt_admitted') {
        continue
      }
      const target = load.targets.get(event.admissionId)
      if (target?.at.seq === event.seq) {
        load.targets.delete(event.admissionId)
      }
    }
  }

  #hasTimelineItem(timeline: TimelineState, id: string): boolean {
    for (const page of timeline.sealed) {
      if (page.items.some((item) => item.id === id)) {
        return true
      }
    }

    return timeline.active.items.some((item) => item.id === id)
  }

  /** 同一时刻只读一个目录；期间再失效，落地后再追一次最新后缀。 */
  #readOutline(real: string): Promise<void> {
    const reads = this.#reads
    if (reads === undefined || isDelegateKey(real)) {
      return Promise.resolve()
    }

    const running = this.#outlineLoads.get(real)
    if (running !== undefined) {
      running.stale = true
      return running.promise
    }

    const load: OutlineLoad = { stale: false, promise: Promise.resolve() }
    this.#outlineLoads.set(real, load)
    load.promise = this.#runOutlineLoad(real, load).finally(() => {
      if (this.#outlineLoads.get(real) === load) {
        this.#outlineLoads.delete(real)
      }
    })
    return load.promise
  }

  async #runOutlineLoad(real: string, load: OutlineLoad): Promise<void> {
    const reads = this.#reads
    if (reads === undefined) {
      return
    }

    while (this.#outlineLoads.get(real) === load && this.#held.has(real)) {
      load.stale = false
      const before = this.#now(real)
      const fromSeq = before.outline.at(-1)?.at.seq ?? null

      try {
        const suffix = await reads.outline(real, fromSeq)
        if (this.#outlineLoads.get(real) !== load || !this.#held.has(real)) {
          return
        }
        const latest = this.#now(real)
        this.#put(real, { ...latest, outline: mergeOutline(latest.outline, suffix, fromSeq) })
      } catch (cause: unknown) {
        if (this.#outlineLoads.get(real) === load && this.#held.has(real)) {
          const latest = this.#now(real)
          this.#put(real, { ...latest, timeline: noteOn(latest.timeline, cause, false) })
        }
        return
      }

      if (!load.stale) {
        return
      }
    }
  }

  #prepend(real: string, events: readonly RunEvent[], earlier: FrameCursor | null): void {
    const latest = this.#now(real)
    const split = partitionByAgent(events)

    for (const [agentId, channel] of split.channels) {
      const key = delegateKey(real, agentId)
      const held = this.#now(key)
      this.#put(key, { ...held, timeline: prependThreadEvents(held.timeline, channel) })
    }

    this.#put(real, {
      ...latest,
      timeline: prependThreadEvents(latest.timeline, split.main),
      earlier,
      restoring: false,
    })
  }

  /* ================= 说一句话 ================= */

  send = ({
    assets,
    configuration,
    onUserMessage,
    port,
    prepare,
    skills,
    text,
    threadId,
  }: SendOptions): void => {
    const current = this.#now(threadId)
    const opened = appendUserMessage(
      current.timeline,
      text,
      Date.now(),
      assets.length,
      skills.map((skill) => skill.name),
    )
    this.#put(threadId, { ...current, timeline: opened })

    if (port === undefined) {
      this.#fail(threadId, new Error(NO_SESSION))
      return
    }

    this.#attach(port)
    this.#releaseSubmission(threadId)

    const submission: PendingSubmission = {
      key: threadId,
      port,
      threadId,
      ready: prepare === undefined,
      cancelRequested: false,
      cancelSent: false,
    }
    this.#submissions.set(threadId, submission)

    void (prepare?.() ?? Promise.resolve(true))
      .then((prepared) => {
        if (!prepared) {
          this.#releaseSubmission(submission)
          this.#fail(threadId, new Error(NO_THREAD))
          return undefined
        }

        submission.ready = true
        if (submission.cancelRequested) {
          this.#cancelUnsubmitted(submission)
          this.#releaseSubmission(submission)
          return undefined
        }

        onUserMessage?.(threadId, text.trim() === '' && assets.length > 0 ? IMAGE_OPENER : text)

        return port.prompt({ threadId, text, assets, configuration, skills }).then((handle) => {
          this.route(handle.sessionId, threadId)
          if (submission.cancelRequested) {
            this.#sendCancellation(submission)
          }
        })
      })
      .catch((cause: unknown) => {
        this.#fail(threadId, cause)
      })
  }

  cancel = (key: string): void => {
    const port = this.#attachedTo
    if (port === null) {
      return
    }

    let submission = this.#submissions.get(key)
    if (submission === undefined) {
      /*
       * 没在跑就没有可取消的轮次。建一条空账会把这一格永久钉住（#pinned 读
       * #submissions），而那条账等不到任何终局帧来销它。
       */
      if (!isSteerable(this.#now(key).timeline.status)) {
        return
      }

      submission = {
        key,
        port,
        threadId: key,
        ready: true,
        cancelRequested: false,
        cancelSent: false,
      }
      this.#submissions.set(key, submission)
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

    if (!submission.ready) {
      /* 没有地址可等：入口那一格的取消即刻落定。 */
      this.#cancelUnsubmitted(submission)

      return
    }

    this.#sendCancellation(submission)
  }

  #sendCancellation(submission: PendingSubmission): void {
    const threadId = submission.threadId

    if (!submission.ready || submission.cancelSent) {
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
  resolvePermission = (key: string, requestId: string, answer: ApprovalAnswer): void => {
    const port = this.#attachedTo

    if (port === null) {
      return
    }

    port.resolvePermission(requestId, answer).catch((cause: unknown) => {
      this.note(key, describeFailure(cause))
    })
  }

  /**
   * 一件本地事故，记进这条对话的转录。
   *
   * 它是本地事故唯一的公开入口：报错只有一种形态,就是转录里的那一条横线。
   *
   * endsTurn 为假：这不是某一轮失败了。重复的同一句话由 pushFailure 挡掉。
   */
  note = (key: string, message: string): void => {
    const current = this.#now(key)

    this.#put(key, {
      ...current,
      timeline: appendLocalError(current.timeline, { message, at: Date.now(), endsTurn: false }),
    })
  }

  /* ================= 内部 ================= */

  /*
   * 写路径要的那一份：先把攒着的帧折进去，再拿。
   *
   * 与 read 分开，是因为它们问的不是同一件事。read 问「订阅者此刻看到的是
   * 什么」，答案必须是已提交的状态；这里问「我要往上面追加，基线是什么」，
   * 答案必须把在途的帧算进去。同一个函数同时回答两者，就是让快照读取带上
   * 副作用。
   */
  #now(key: string): Transcript {
    return this.#settle(key)
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
      if (!isDelegateKey(key) && selectIsBusy(transcript.timeline)) {
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
   * 每条对话只有一个身份；一拍内每个脏身份只通知一次。
   */
  #flush = (): void => {
    this.#waiting = false

    const dirty = this.#dirty

    this.#dirty = new Set<string>()

    for (const real of dirty) {
      this.#settle(real)
      this.#fire(real)
    }

    this.#republish()
  }

  #put(real: string, next: Transcript): void {
    /* 一次解析，一次叫醒：这里是叫醒的两个入口之一，另一个是 #queue。 */
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
    /* 先删再插：Map 的插入序因此就是 LRU 序，最旧的恒在表头。 */
    this.#held.delete(real)
    this.#held.set(real, next)
    this.#trim(real)
  }

  /*
   * 重建不出来的那些：有人在看、在跑、有在飞的提交、或还有没折进去的帧。
   *
   * 派发通道随派出它的那条对话一起回收（#evict），所以一条通道被人看着就等于它的
   * 对话被人看着 —— 否则 #trim 会把一块正在屏幕上的子代理经过删掉。
   */
  #pinned(key: string): boolean {
    if (
      this.#listeners.has(key) ||
      this.#submissions.has(key) ||
      this.#pending.has(key) ||
      this.#historyLoads.has(key) ||
      this.#outlineLoads.has(key) ||
      this.#running.has(key)
    ) {
      return true
    }

    if (isDelegateKey(key)) {
      return false
    }

    const prefix = delegateKey(key, '')

    for (const listening of this.#listeners.keys()) {
      if (listening.startsWith(prefix)) {
        return true
      }
    }

    return false
  }

  #trim(exempt: string): void {
    for (const key of this.#held.keys()) {
      if (this.#held.size <= HELD_CEILING) {
        return
      }

      if (key !== exempt && !this.#pinned(key)) {
        this.#evict(key)
      }
    }
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
  #queue(real: string, events: readonly RunEvent[]): void {
    const split = partitionByAgent(events)

    for (const [agentId, channel] of split.channels) {
      this.#absorb(delegateKey(real, agentId), channel)
    }

    if (split.main.length > 0) {
      this.#absorb(real, split.main)
    }
  }

  /** 一批帧攒进一条转录，并说一声它变了。 */
  #absorb(real: string, events: readonly RunEvent[]): void {
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

    const terminal = waiting.some(endsRun)
    const submission = this.#submissions.get(real)

    /* 一轮开张或收口，目录就多一行或多一段答：库里那一行已经落定，重读一次。 */
    if (terminal || waiting.some(opensTurn)) {
      void this.#readOutline(real)
    }
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
   * 地址还没到就攒着，等 route 认领：会话号随 prompt 的答复或打开的答复回来，两者
   * 都慢于帧。上界在明处（UNROUTED_*），挤掉的那些仍然在帧日志里。
   */
  #route(events: readonly RunEvent[], sessionId: string): void {
    const owner = this.#routes.get(sessionId)

    if (owner !== undefined) {
      this.#queue(owner, events)

      return
    }

    const held = this.#unrouted.get(sessionId)

    if (held === undefined) {
      /* 插入序即 LRU 序：满了丢最旧的那一条会话。 */
      if (this.#unrouted.size >= UNROUTED_SESSION_CEILING) {
        for (const oldest of this.#unrouted.keys()) {
          this.#unrouted.delete(oldest)

          if (this.#unrouted.size < UNROUTED_SESSION_CEILING) {
            break
          }
        }
      }

      this.#unrouted.set(sessionId, events.slice(-UNROUTED_FRAME_CEILING))

      return
    }

    for (const event of events) {
      held.push(event)
    }

    if (held.length > UNROUTED_FRAME_CEILING) {
      held.splice(0, held.length - UNROUTED_FRAME_CEILING)
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
