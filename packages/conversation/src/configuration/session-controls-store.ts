import { createExternalStore } from '@poietica/external-store'
import type { SessionConfigControl, SessionConfigPort, SessionConfigReport } from '../agent/config'
import type { SessionGoal } from '../agent/goal'
import type { PermissionPosturePort } from '../agent/permission'
import type { OpenedThread, ThreadPort, ThreadSnapshot } from '../agent/thread'
import type { SessionUsage, SessionUsagePort, SessionUsageReport } from '../agent/usage'
import { describeFailure } from '../failure'
import type { TranscriptSink } from '../transcript/transcript-sink'
import { ArrivalOrder } from './arrival-order'
import {
  isPermissionPostureChange,
  pendingPostureAlignment,
  projectPosture,
} from './permission-posture'

/* 改动返回新表；未变保留引用，让上层 Object.is 跳过重画。 */
function withEntry<T>(map: ReadonlyMap<string, T>, key: string, value: T): ReadonlyMap<string, T> {
  if (map.get(key) === value) {
    return map
  }

  const next = new Map(map)

  next.set(key, value)

  return next
}

function withoutEntry<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  if (!map.has(key)) {
    return map
  }

  const next = new Map(map)

  next.delete(key)

  return next
}

interface Held {
  readonly selectors: ReadonlyMap<string, readonly SessionConfigControl[]>
  readonly selectorFailure: ReadonlyMap<string, string>
  readonly usage: ReadonlyMap<string, SessionUsage>
  /** 目标模式此刻的事实，按对话。没有目标在跑的对话不在表里。 */
  readonly goal: ReadonlyMap<string, SessionGoal>
}

const EMPTY: Held = {
  selectors: new Map(),
  selectorFailure: new Map(),
  usage: new Map(),
  goal: new Map(),
}

/**
 * 失败往哪里说一声。与 AgentCapabilityStore 的 CapabilityFailureReport 同一条规矩：
 * 屏幕要的是「能不能再试一次」，日志与降级要的是「因为什么」，两条分开报、处置不同
 * —— 改不动是 agent 拒了这次改动，读不回来是这条对话连不上。可选：这台 store 因此
 * 仍能在 Node 里裸构造单测。
 */
export interface SessionControlsFailureReport {
  /** set_config 被拒。屏幕上那颗胶囊自己弹回权威值，这里只负责让它留下痕迹。 */
  readonly changeFailed: (cause: unknown) => void
  /** 重开这条对话失败。同一次失败另有两个后果，见 #reopen。 */
  readonly openFailed: (cause: unknown) => void
}

export type SessionControlMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

interface SessionControlsOptions {
  readonly config?: SessionConfigPort | undefined
  readonly port?: ThreadPort | undefined
  /** 批准方式的持久意图。缺席即不对齐，这台 store 因此仍能裸构造单测。 */
  readonly posture?: PermissionPosturePort | undefined
  readonly report?: SessionControlsFailureReport | undefined
  readonly transcripts?: TranscriptSink | undefined
  /** 用量的到达口。缺席即不画，这台 store 因此仍能裸构造单测。 */
  readonly usage?: SessionUsagePort | undefined
}

/** Owns session controls and their command ordering; the agent remains authoritative. */
export class SessionControlsStore {
  readonly #port: ThreadPort | undefined

  readonly #config: SessionConfigPort | undefined

  readonly #transcripts: TranscriptSink | undefined

  readonly #store = createExternalStore<Held>({ read: () => this.#held })

  readonly #posture: PermissionPosturePort | undefined

  readonly #report: SessionControlsFailureReport | undefined

  readonly #usage: SessionUsagePort | undefined

  #held: Held = EMPTY
  #disposed = false

  /* 问过的对话不再问第二遍：重读是显式动作，不是渲染的副作用。 */
  #asked = new Set<string>()

  /* 会话归属由 TranscriptStore 的 #routes 单点持有。 */

  /*
   * 这条对话此刻在飞的那一次改动，同时是它的队伍。串行不是为了省往返：agent 的答复
   * 才是下一步的判据，并发发出的第二条命令用的是一张已经作废的表。
   */
  #inflight = new Map<string, Promise<void>>()

  /* 这条对话的表按什么先后写入。作废在 forget。 */
  #order = new Map<string, ArrivalOrder>()

  /*
   * 这条对话已经为哪一个意图补发过对齐。同一个意图不补第二次：agent 拒了那一次改动
   * 会走 #reopen 拉回权威表，那正是 #remember 再被叫到的时刻 —— 不记这一格就是
   * 一个自己喂自己的循环。
   */
  #alignedTo = new Map<string, string>()

  constructor({ config, port, posture, report, transcripts, usage }: SessionControlsOptions) {
    this.#config = config
    this.#port = port
    this.#posture = posture
    this.#report = report
    this.#transcripts = transcripts
    this.#usage = usage
  }

  snapshot = (): Held => this.#held

  /** 自己的读者自己收，并交回退订的办法。与 AgentCapabilityStore 同形状（subscribe/snapshot 箭头字段），useSyncExternalStore 直接可用。 */
  subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener)

  start = (): (() => void) => {
    if (this.#disposed) {
      throw new Error('SessionControlsStore is disposed.')
    }
    let active = true
    const stop = this.#config?.subscribe((report) => {
      if (active && !this.#disposed) {
        this.#reported(report)
      }
    })
    const stopUsage = this.#usage?.subscribe((report) => {
      if (active && !this.#disposed) {
        this.#usageReported(report)
      }
    })
    return () => {
      active = false
      try {
        stop?.()
      } finally {
        stopUsage?.()
      }
    }
  }

  dispose = (): void => {
    this.#disposed = true
    this.#asked.clear()
    this.#inflight.clear()
    this.#order.clear()
    this.#alignedTo.clear()
    this.#held = EMPTY
  }

  /** 这条对话所持有的会话给出的选择器；从没拿到过就是 undefined。 */
  selectorsOf = (threadId: string): readonly SessionConfigControl[] | undefined =>
    this.#held.selectors.get(threadId)

  /** 上一次认领或改动失败时的说法，按对话记。 */
  selectorFailureOf = (threadId: string): string | undefined =>
    this.#held.selectorFailure.get(threadId)

  /** 这条对话此刻的目标；没有目标在跑是 undefined。 */
  goalOf = (threadId: string): SessionGoal | undefined => this.#held.goal.get(threadId)

  /** 这条对话所持有的会话最近报的上下文用量；从没报过就是 undefined。 */
  usageOf = (threadId: string): SessionUsage | undefined => this.#held.usage.get(threadId)

  /*
   * 一份答复到手：新开一条、认领一条、重读一条，三条路唯一的落地处。路由、经过、
   * 选择器都在同一个答复里，这也是唯一不需要再问一次的时刻。经过先落地再谈选择器：
   * 同一份答复的两半，谁先谁后不该被下游看见。
   */
  opened = (answer: OpenedThread): void => {
    if (this.#disposed) {
      return
    }
    const threadId = answer.thread.threadId

    this.#hold(answer)
    this.#asked.add(threadId)

    this.#orderOf(threadId).arrive()
    this.#remember(threadId, answer.selectors, answer.goal)
  }

  #snapshot(answer: ThreadSnapshot): void {
    const threadId = answer.thread.threadId
    if (answer.usage !== undefined && !this.#held.usage.has(threadId)) {
      this.#commit({ usage: withEntry(this.#held.usage, threadId, answer.usage) })
    }
  }

  forget = (threadId: string): void => {
    this.#asked.delete(threadId)

    /* 在飞的那一次不取消 —— 它已经发出去了，收不回来；只是不再由它排队。 */
    this.#inflight.delete(threadId)
    this.#order.delete(threadId)
    this.#alignedTo.delete(threadId)

    /* TranscriptStore.forget 同步回收唯一归属表。 */

    this.#commit({
      selectors: withoutEntry(this.#held.selectors, threadId),
      selectorFailure: withoutEntry(this.#held.selectorFailure, threadId),
      usage: withoutEntry(this.#held.usage, threadId),
      goal: withoutEntry(this.#held.goal, threadId),
    })
  }

  /*
   * 认领一条不是本次运行开出来的对话：让它握住一个会话。原生侧在同一答复里给出这条
   * 对话现在持有的会话与整张选择器表，与新开一条走同一条路 —— 选择器只有一个到达口，
   * 没有"空表"和"读失败"两种半状态。
   *
   * 已经问过就什么都不做：手上那张表是 agent 最近一次的原话，变了它自己会推过来。
   */
  adopt = (threadId: string): void => {
    if (this.#asked.has(threadId)) {
      return
    }

    void this.#reopen(threadId)
  }

  /* 再连一次。失败那一格不在这里清，唯一的清点是拿到权威表的 #remember；交回的承诺决定重试图标转多久。 */
  retrySelectors = (threadId: string): Promise<void> => this.#reopen(threadId)

  /**
   * 改这条对话的一项会话设置；答案就是改完之后的整张表。
   *
   * 批准方式同时是一个跨会话的决定：既发给这条会话，也落成持久意图，写在发出之前
   * —— 与 default_model 的落盘同一条顺序：失手时盘上那份仍是用户上一次真的按下的那一颗。
   */
  selectControl = (
    threadId: string,
    controlId: string,
    value: string,
    input?: string,
  ): Promise<SessionControlMutationResult> => {
    if (this.#disposed) {
      return Promise.resolve({ ok: false, error: '会话已关闭' })
    }
    const control = this.#held.selectors.get(threadId)?.find((offered) => offered.id === controlId)

    if (control !== undefined && isPermissionPostureChange(control, value)) {
      this.#posture?.write(value)
      this.#alignedTo.set(threadId, value)
    }

    return this.#dispatch(threadId, controlId, value, input)
  }

  /*
   * 下发一次改动，排在这条对话自己的队伍后面；用户选择与 #remember 的自动对齐都经
   * 这里发出 set_config。队列按对话分不按连接分：同一条对话上的两次改动必须分先后
   * —— 后一次要用前一次的答复当判据。
   *
   * 失败不把技术原因常驻到会话设置那一格：那格说的是"这条对话连没连上 agent"。这里
   * 向 agent 重问权威表，UI 回到真正生效的值 —— 权威回滚，不是本地猜旧值。
   */
  #dispatch(
    threadId: string,
    controlId: string,
    value: string,
    input?: string,
  ): Promise<SessionControlMutationResult> {
    const config = this.#config

    if (config === undefined) {
      return Promise.resolve({ ok: false, error: '会话配置不可用' })
    }

    const order = this.#orderOf(threadId)
    const queued = this.#inflight.get(threadId) ?? Promise.resolve()
    const run = queued.then(async (): Promise<SessionControlMutationResult> => {
      if (this.#disposed || this.#order.get(threadId) !== order) {
        return { ok: false, error: '会话已关闭' }
      }
      const ticket = order.issue()

      try {
        const offered = await config.select(threadId, controlId, value, input)
        if (this.#order.get(threadId) === order && order.isLatest(ticket)) {
          this.#remember(threadId, offered)
        }
        return { ok: true }
      } catch (reason: unknown) {
        if (this.#disposed || this.#order.get(threadId) !== order) {
          return { ok: false, error: '会话已关闭' }
        }
        this.#report?.changeFailed(reason)
        if (this.#order.get(threadId) === order) {
          await this.#reopen(threadId)
        }
        return { ok: false, error: describeFailure(reason) }
      }
    })

    const tail = run.then(() => undefined)
    this.#inflight.set(threadId, tail)
    void tail.then(() => {
      if (this.#inflight.get(threadId) === tail) {
        this.#inflight.delete(threadId)
      }
    })
    return run
  }

  /* 重新打开一次，拿回权威的整张表。交回可等待的东西：下发失败后队伍里的下一条要等它落地，否则拿着已作废的表出发。 */
  async #reopen(threadId: string): Promise<void> {
    if (this.#disposed) {
      return
    }
    const port = this.#port

    if (port === undefined) {
      return
    }

    /* 这一趟的归属。forget 换掉它之后，回来的答复属于一条已经不存在的对话。 */
    const order = this.#orderOf(threadId)

    this.#asked.add(threadId)
    this.#transcripts?.opening(threadId)

    const snapshot = port.read(threadId).then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    )
    const activation = port.open(threadId).then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    )

    const read = await snapshot
    if (this.#order.get(threadId) !== order) {
      return
    }

    if (read.ok) {
      this.#snapshot(read.value)
    } else {
      this.#transcripts?.failed(threadId, read.cause)
    }

    const opened = await activation
    if (this.#order.get(threadId) !== order) {
      return
    }

    if (opened.ok) {
      this.opened(opened.value)
      return
    }

    this.#noteSelectorFailure(threadId, opened.cause)
    if (read.ok) {
      this.#transcripts?.failed(threadId, opened.cause)
    }
    this.#report?.openFailed(opened.cause)
  }

  /*
   * 记下这条对话现在握着哪个会话。会话在 port.open() 里诞生（或被装载回来），这是
   * 反查表唯一建立得起来的时刻；列表读回来的那些号可能是上一次运行留下的，而推送
   * 只会来自活着的会话。
   */
  #hold(answer: OpenedThread): void {
    const sessionId = answer.thread.sessionId

    if (sessionId !== null) {
      this.#transcripts?.route(sessionId, answer.thread.threadId, answer.transcript)
    }
  }

  /*
   * agent 自己报来了一张新表，到达口仍然是 #remember —— 不是第三条取数路径，只是
   * 第三个说话的人；失败那一格照样清。认不得的会话号直接丢：那是别的连接或已不在
   * 的对话。
   */
  #reported(report: SessionConfigReport): void {
    const threadId = this.#transcripts?.ownerOf(report.sessionId)

    if (threadId === undefined) {
      return
    }

    this.#orderOf(threadId).arrive()
    this.#remember(threadId, report.controls, report.goal)
  }

  /* agent 报来一份用量，按会话归属更新；#reopen 的快照只补尚无用量的对话，不覆盖已有推送。 */
  #usageReported(report: SessionUsageReport): void {
    const threadId = this.#transcripts?.ownerOf(report.sessionId)

    if (threadId === undefined) {
      return
    }

    this.#commit({ usage: withEntry(this.#held.usage, threadId, report.usage) })
  }

  /* 这条对话的先后。没有就现在开一份。 */
  #orderOf(threadId: string): ArrivalOrder {
    const held = this.#order.get(threadId)

    if (held !== undefined) {
      return held
    }

    const fresh = new ArrivalOrder()

    this.#order.set(threadId, fresh)

    return fresh
  }

  /*
   * 一张表到了：三条路（open / select / agent 主动上报）唯一的汇合处，原样存下来
   * —— 这条会话此刻在用什么，只有 agent 自己有资格回答。唯一例外是批准方式正在
   * 补发的那一趟：画的是要收敛到的那一档（见 projectPosture），否则屏幕会先闪一个
   * 用户从没选过、马上要被覆盖的中间值。
   */
  #remember(
    threadId: string,
    offered: readonly SessionConfigControl[],
    goal?: SessionGoal | null,
  ): void {
    /* 判据全来自刚落地的那张表：agent 提供哪些档位由它说了算。同一意图只补一次，见 #alignedTo。 */
    const decision = pendingPostureAlignment(offered, this.#posture?.read())
    const aligning =
      decision === undefined || this.#alignedTo.get(threadId) === decision.wanted
        ? undefined
        : decision

    this.#commit({
      selectors: withEntry(
        this.#held.selectors,
        threadId,
        aligning === undefined ? offered : projectPosture(offered, aligning),
      ),
      selectorFailure: withoutEntry(this.#held.selectorFailure, threadId),
      ...(goal === undefined
        ? {}
        : {
            goal:
              goal === null
                ? withoutEntry(this.#held.goal, threadId)
                : withEntry(this.#held.goal, threadId, goal),
          }),
    })

    if (aligning !== undefined) {
      this.selectControl(threadId, aligning.control.id, aligning.wanted)
    }
  }

  #noteSelectorFailure(threadId: string, reason: unknown): void {
    this.#commit({
      selectorFailure: withEntry(this.#held.selectorFailure, threadId, describeFailure(reason)),
    })
  }

  /* 换一份状态再叫一声；引用相同即这次提交什么都没改，不叫 —— 每一声都是一次重画。 */
  #commit(patch: Partial<Held>): void {
    if (this.#disposed) {
      return
    }
    const next: Held = { ...this.#held, ...patch }

    if (
      next.selectors === this.#held.selectors &&
      next.selectorFailure === this.#held.selectorFailure &&
      next.usage === this.#held.usage &&
      next.goal === this.#held.goal
    ) {
      return
    }

    this.#held = next
    this.#store.notify()
  }
}
