import type {
  OpenedThread,
  PermissionPosturePort,
  SessionConfigControl,
  SessionConfigPort,
  SessionConfigReport,
  SessionUsage,
  SessionUsagePort,
  SessionUsageReport,
  ThreadPort,
  ThreadRecord,
} from '@poietica/agent-contract'
import { ArrivalOrder } from './arrival-order'
import { describeFailure } from './describe-failure'
import { withEntry, withoutEntry } from './immutable-map'
import { permissionControlOf, postureAlignment } from './permission-posture'
import type { TranscriptSink } from './transcript-sink'

interface Held {
  readonly selectors: ReadonlyMap<string, readonly SessionConfigControl[]>
  readonly selectorFailure: ReadonlyMap<string, string>
  readonly usage: ReadonlyMap<string, SessionUsage>
}

const EMPTY: Held = { selectors: new Map(), selectorFailure: new Map(), usage: new Map() }

/**
 * 失败往哪里说一声。与 AgentCapabilityStore 的 CapabilityFailureReport 是同一条
 * 规矩：屏幕要的是「能不能再试一次」，日志与降级要的是「因为什么」，两者不是同
 * 一件事，也不该由同一格承担。
 *
 * 两条分开报，因为它们的处置不同：改不动是 agent 拒了这一次改动，读不回来是这条
 * 对话连不上。可选 —— 这台 store 因此仍然能在 Node 里裸构造单测。
 */
export interface SessionControlsFailureReport {
  /** set_config 被拒。屏幕上那颗胶囊自己弹回权威值，这里只负责让它留下痕迹。 */
  readonly changeFailed: (cause: unknown) => void
  /** 重开这条对话失败。同一次失败另有两个后果，见 #reopen。 */
  readonly openFailed: (cause: unknown) => void
}

export interface SessionControlsOptions {
  readonly config?: SessionConfigPort | undefined
  readonly port?: ThreadPort | undefined
  /** 批准方式的持久意图。缺席即不对齐，这台 store 因此仍能裸构造单测。 */
  readonly posture?: PermissionPosturePort | undefined
  readonly report?: SessionControlsFailureReport | undefined
  readonly transcripts?: TranscriptSink | undefined
  /** 用量的到达口。缺席即不画，这台 store 因此仍能裸构造单测。 */
  readonly usage?: SessionUsagePort | undefined
}

/**
 * 每条对话背后那个会话提供哪些可调项，以及每一项此刻生效的是什么。
 *
 * 权威只有一个，就是 agent。这里存的是它最近一次为那条会话报的原话：三条路
 * （open 的答复、set_config 的答复、agent 主动上报）汇进同一个 #remember，屏幕
 * 画的就是它。没有投影，没有影子值，也没有"显示值"与"实际值"两格 —— 那两格一旦
 * 分开，屏幕上写甲而会话里跑乙就成了合法状态。
 *
 * ACP 把配置定义成会话级的：session/new、session/load、session/set_config_option、
 * 以及 session/update 的 config_option_update 全部按 sessionId 寻址，而 session/new
 * 不带任何配置参数。所以"上次选的那个批准方式"不可能由协议自己带过来，只能由这一
 * 层在一张表到达时补发一次：补的值就是用户自己上次按下的那一颗（意图由
 * PermissionPosturePort 持有），同一个意图只补一次，agent 没提供的档位不补。
 *
 * 模型不在此列。它的持久位置是 agent 自己的 config.toml（default_model），由 agent
 * 开会话时读，这一层不碰。
 *
 * 下发按对话串行。ACP 规定改一项可能增删另一项（见 @poietica/agent-contract 的 config.ts，
 * 以及原生侧 commands.rs 的 select 文档），所以同一条会话上的两次改动必须分先后：
 * 后一次要用前一次的答复当判据。
 *
 * 串行管不到 agent 自己说话那一条。答复与推送是两条并发的到达，先后因此由
 * ArrivalOrder 定，而不由落地顺序定 —— 后发的那一问才是最新的问题，先回来的那
 * 张表答的是上一个。
 *
 * 依赖全部构造时交进来：端口、配置、批准意图、转录。这台 store 因此可以在没有任何
 * 进程单例的情况下被单独构造。
 *
 * 自己的订阅由 subscribe 交出去，不借别人那一条：一条对话的记录（名字、活动时间、
 * 置顶）和它背后那个会话是两份互不相交的状态，读者也是两批 —— 侧栏与标签读前者，
 * 输入框旁的选择器读后者。合用一条通知，代价是任何一侧变化都叫醒另一侧的全部读者。
 */
export class SessionControlsStore {
  readonly #port: ThreadPort | undefined

  readonly #config: SessionConfigPort | undefined

  readonly #transcripts: TranscriptSink | undefined

  readonly #listeners = new Set<() => void>()

  readonly #posture: PermissionPosturePort | undefined

  readonly #report: SessionControlsFailureReport | undefined

  readonly #usage: SessionUsagePort | undefined

  #held: Held = EMPTY

  /* 问过的对话不再问第二遍：重读是显式动作，不是渲染的副作用。 */
  #asked = new Set<string>()

  /* 会话号 → 对话。推送只带前者，而这一侧的一切都按后者记。 */
  #sessions = new Map<string, string>()

  /*
   * 这条对话此刻在飞的那一次改动，同时是它的队伍。
   *
   * 串行不是为了省往返：agent 的答复才是下一步的判据，并发发出去的第二条命令用的
   * 是一张已经作废的表。
   */
  #inflight = new Map<string, Promise<void>>()

  /* 这条对话的表按什么先后写入。作废在 forget。 */
  #order = new Map<string, ArrivalOrder>()

  /*
   * 这条对话已经为哪一个意图补发过对齐。
   *
   * 同一个意图不补第二次：agent 拒了那一次改动会走 #reopen 拉回权威表，而那正是
   * #align 再次被叫到的时刻 —— 不记这一格就是一个自己喂自己的循环。
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

  /**
   * 自己的读者自己收，并交回退订的办法。
   *
   * 与 AgentCapabilityStore 同一个形状（subscribe / snapshot 两个箭头字段），
   * useSyncExternalStore 直接就能用；引用终生不变，订阅不会因为重画而重装。
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)

    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 开始听 agent 自己说话，并交回停下来的办法。
   *
   * 订阅与退订成对地交给 effect，是 React 对这件事自己的答案：装载几次就订阅几次、
   * 退订几次，不可能配不平。放在构造函数里则配不平 —— store 由 useState 造，开发
   * 模式下的装载/卸载/再装载会把订阅退掉，而构造函数不会跑第二遍。
   */
  start = (): (() => void) => {
    const stop = this.#config?.subscribe((report) => {
      this.#reported(report)
    })

    const stopUsage = this.#usage?.subscribe((report) => {
      this.#usageReported(report)
    })

    return () => {
      stop?.()
      stopUsage?.()
    }
  }

  /** 这条对话所持有的会话给出的选择器；从没拿到过就是 undefined。 */
  selectorsOf = (threadId: string): readonly SessionConfigControl[] | undefined =>
    this.#held.selectors.get(threadId)

  /** 上一次认领或改动失败时的说法，按对话记。 */
  selectorFailureOf = (threadId: string): string | undefined =>
    this.#held.selectorFailure.get(threadId)

  /** 这条对话所持有的会话最近报的上下文用量；从没报过就是 undefined。 */
  usageOf = (threadId: string): SessionUsage | undefined => this.#held.usage.get(threadId)

  /**
   * 一份答复到手：新开一条、认领一条、重读一条，三条路唯一的落地处。
   *
   * 会话是跟着这条对话一起开出来的，路由、经过、选择器都在同一个答复里，所以这也是
   * 唯一不需要再问一次的时刻。经过先落地，再谈选择器：它们是同一份答复的两半，谁先
   * 谁后不该被下游看见。
   */
  opened = (answer: OpenedThread): void => {
    const threadId = answer.thread.threadId

    this.#hold(answer.thread)
    this.#asked.add(threadId)
    this.#transcripts?.adopt(threadId, answer.events, answer.history)

    /* 一整份权威答复：此前发出去的那些下发，答案都已经过期。 */
    this.#orderOf(threadId).arrive()
    this.#remember(threadId, answer.selectors)

    /* 账本垫底，活报告优先：这一格只在该对话还一无所知时落座。答复里那份
    是上一轮落定时记的快照；本次运行若已有 agent 直报，那一份更新，不让位。 */
    if (answer.usage !== undefined && !this.#held.usage.has(threadId)) {
      this.#commit({ usage: withEntry(this.#held.usage, threadId, answer.usage) })
    }
  }

  /**
   * 这条对话不存在了。
   *
   * 按对话记的每一格都在这个文件里，所以作废它们的地方也只该有这一个。
   */
  forget = (threadId: string): void => {
    this.#asked.delete(threadId)

    /* 在飞的那一次不取消 —— 它已经发出去了，收不回来；只是不再由它排队。 */
    this.#inflight.delete(threadId)
    this.#order.delete(threadId)
    this.#alignedTo.delete(threadId)

    /* 会话号那张反查表同样按对话记。#hold 只写不删，这里是它唯一的出口。 */
    for (const [sessionId, owner] of this.#sessions) {
      if (owner === threadId) {
        this.#sessions.delete(sessionId)
      }
    }

    this.#commit({
      selectors: withoutEntry(this.#held.selectors, threadId),
      selectorFailure: withoutEntry(this.#held.selectorFailure, threadId),
      usage: withoutEntry(this.#held.usage, threadId),
    })
  }

  /*
   * 认领一条不是本次运行开出来的对话：让它握住一个会话。
   *
   * 原生侧在同一个答复里给出这条对话现在持有的会话，和 agent 为它报的整张选择器表，
   * 与新开一条对话走的是同一条路 —— 所以选择器只有一个到达口，也就没有"空表"和
   * "读失败"这两种半状态。
   *
   * 已经问过就什么都不做。手上那张表就是 agent 最近一次的原话；它变了的时候 agent
   * 自己会推过来（start 里订的那一条）。打开一条历史对话不是修改它的时刻。
   */
  adopt = (threadId: string): void => {
    if (this.#asked.has(threadId)) {
      return
    }

    void this.#reopen(threadId)
  }

  retrySelectors = (threadId: string): void => {
    this.#commit({ selectorFailure: withoutEntry(this.#held.selectorFailure, threadId) })
    void this.#reopen(threadId)
  }

  /**
   * 改这条对话的一项会话设置；答案就是改完之后的整张表。
   *
   * 批准方式多一件事：它同时是一个跨会话的决定，所以这一次点击既发给这条会话，也
   * 落成持久意图。写在发出之前，与 default_model 同一条顺序（见 apps/desktop 的
   * agent-session.ts）：失手时盘上那份仍是用户上一次真的按下的那一颗。
   */
  selectControl = (threadId: string, controlId: string, value: string): void => {
    const control = this.#held.selectors.get(threadId)?.find((offered) => offered.id === controlId)

    if (control?.purpose === 'mode') {
      this.#posture?.write(value)
      this.#alignedTo.set(threadId, value)
    }

    this.#dispatch(threadId, controlId, value)
  }

  /*
   * 下发一次改动，排在这条对话自己的队伍后面。
   *
   * 这是整个文件里唯一发出 set_config 的地方，而它只有一个调用者：用户点了选择器。
   *
   * 队列按对话分，不按连接分：两条对话各改各的互不相干，而同一条对话上的两次改动
   * 必须分先后 —— 后一次要用前一次的答复当判据。
   *
   * 失败不把技术原因常驻到会话设置那一格上：那一格说的是"这条对话连没连上 agent"，
   * 一次改动失败不是那件事。这里向 agent 重问一次权威表，UI 因此回到真正生效的值，
   * 是权威回滚，不是本地猜一个旧值填回去。
   */
  #dispatch(threadId: string, controlId: string, value: string): void {
    const config = this.#config

    if (config === undefined) {
      return
    }

    const queued = this.#inflight.get(threadId) ?? Promise.resolve()

    const run = queued.then(async () => {
      const order = this.#orderOf(threadId)
      const ticket = order.issue()

      try {
        const offered = await config.select(threadId, controlId, value)

        /* 号过期了，说明这一趟在飞的时候 agent 已经自己说过话，那张表更新。 */
        if (order.isLatest(ticket)) {
          this.#remember(threadId, offered)
        }
      } catch (reason: unknown) {
        /*
         * 原因交出去，值交回权威。
         *
         * 这两件事不能互相顶替：向 agent 重问一次修得回屏幕上的值，修不回「为什么
         * 被拒」—— 密钥过期、模型下线、参数不被接受，全都长成同一次静默的弹回。
         * 这里不写进 selectorFailure，那一格说的是「这条对话连没连上 agent」。
         */
        this.#report?.changeFailed(reason)

        await this.#reopen(threadId)
      }
    })

    this.#inflight.set(threadId, run)

    /* run 自己不会拒绝：上面那个 try 把两条路都收了。 */
    void run.then(() => {
      if (this.#inflight.get(threadId) === run) {
        this.#inflight.delete(threadId)
      }
    })
  }

  /*
   * 把这条对话重新打开一次，拿回权威的整张表。
   *
   * 交回一个可等待的东西，因为下发失败之后队伍里的下一条要等它落地 —— 不等就会拿着
   * 一张已经作废的表出发。
   */
  async #reopen(threadId: string): Promise<void> {
    const port = this.#port

    if (port === undefined) {
      return
    }

    this.#asked.add(threadId)

    /* 这一趟要回来的不只是选择器，还有这条对话的经过。 */
    this.#transcripts?.opening(threadId)

    try {
      this.opened(await port.open(threadId))
    } catch (reason: unknown) {
      this.#noteSelectorFailure(threadId, reason)

      /* 同一次失败的两个后果：设置那一格画不出来，对话也打不开。 */
      this.#transcripts?.failed(threadId, reason)

      /* 那两处都是画给人看的。日志与降级是第三个用途，同一份原因。 */
      this.#report?.openFailed(reason)
    }
  }

  /*
   * 记下这条对话现在握着哪个会话。
   *
   * 会话是在 port.open() 里诞生（或被装载回来）的，所以那一处就是这张反查表唯一
   * 建立得起来的时刻。列表读回来的那些号不算：它们可能是上一次运行留下的，而推送
   * 只会来自活着的会话。
   */
  #hold(thread: ThreadRecord): void {
    const sessionId = thread.sessionId

    if (sessionId === null) {
      return
    }

    this.#sessions.set(sessionId, thread.threadId)

    /* 同一个事实，转录那一侧也要一份：会话号到手在前，第一帧到达在后。 */
    this.#transcripts?.route(sessionId, thread.threadId)
  }

  /*
   * agent 自己报来了一张新表。
   *
   * 到达口仍然是 #remember —— 与 open 和 select 同一个。所以这不是第三条取数路径，
   * 只是第三个说话的人；失败那一格照样清。
   *
   * 认不得的会话号直接丢掉，那是别的连接或者已经不在的对话。
   */
  #reported(report: SessionConfigReport): void {
    const threadId = this.#sessions.get(report.sessionId)

    if (threadId === undefined) {
      return
    }

    this.#orderOf(threadId).arrive()
    this.#remember(threadId, report.controls)
  }

  /*
   * agent 报来了一份用量。
   *
   * 与 #reported 同一条到达路径、同一张反查表；但它没有 open/select 那两条路 ——
   * 用量是 agent 主动推的，没有任何命令能把它问回来，所以也不参与 ArrivalOrder。
   */
  #usageReported(report: SessionUsageReport): void {
    const threadId = this.#sessions.get(report.sessionId)

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
   * 一张表到了。这是三条路（open / select / agent 主动上报）唯一的汇合处。
   *
   * 原样存下来。屏幕上写的就是 agent 说的那一句，中间没有第二个人插话 —— 这条会话
   * 此刻在用什么，只有它自己有资格回答。
   */
  #remember(threadId: string, offered: readonly SessionConfigControl[]): void {
    this.#commit({
      selectors: withEntry(this.#held.selectors, threadId, offered),
      selectorFailure: withoutEntry(this.#held.selectorFailure, threadId),
    })

    this.#align(threadId, offered)
  }

  /*
   * 让这条会话回到用户上次选的那个批准方式。
   *
   * 判据全部来自刚落地的那张表：agent 提供哪些档位由它说了算。补发走 selectControl，
   * 所以「发出 set_config」仍然只有一条路。
   */
  #align(threadId: string, offered: readonly SessionConfigControl[]): void {
    const posture = this.#posture

    if (posture === undefined) {
      return
    }

    const control = permissionControlOf(offered)

    if (control === undefined) {
      return
    }

    const wanted = postureAlignment(control, posture.read())

    if (wanted === undefined || this.#alignedTo.get(threadId) === wanted) {
      return
    }

    this.selectControl(threadId, control.id, wanted)
  }

  #noteSelectorFailure(threadId: string, reason: unknown): void {
    this.#commit({
      selectorFailure: withEntry(this.#held.selectorFailure, threadId, describeFailure(reason)),
    })
  }

  /*
   * 换一份状态，然后叫一声。
   *
   * 没变就不叫：两张表的引用相同意味着这次提交什么都没改，而每一声都是一次重画。
   */
  #commit(patch: Partial<Held>): void {
    const next: Held = { ...this.#held, ...patch }

    if (
      next.selectors === this.#held.selectors &&
      next.selectorFailure === this.#held.selectorFailure &&
      next.usage === this.#held.usage
    ) {
      return
    }

    this.#held = next
    this.#announce()
  }

  #announce(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}
