import type {
  AgentCapabilityPort,
  AgentToolkit,
  PermissionPosturePort,
  SessionConfigControl,
} from '../agent'
import { ArrivalOrder } from './arrival-order'
import { describeFailure } from './describe-failure'
import { isPermissionPostureChange, pendingPostureAlignment } from './permission-posture'

/*
 * 锚会话提供哪些可调项，以及每一项此刻生效的是什么。
 *
 * 只有一份状态：agent 上一次报回来的那张表，外加它上一次说不出话的理由。模型、
 * 模式、推理档位都在表里，一次答复整张换掉 —— 协议就是这么定义的：ACP 的
 * session/new 与 set_config 都回整张表，理由逐字是 changing one may add or remove
 * another（见 ./agent 的 config.ts）。
 *
 * 所以这里没有"人选中了什么"的第二份记录。选中就是生效：拨动一个选择器就是往
 * agent 发一次 set_config，屏幕上的值一律来自它的答复。
 *
 * 这张表只描述锚会话自己。别的对话各自握着自己的会话，值问它们自己的会话要（见
 * SessionControlsStore）。跨会话持久意图不复制进 store：模型默认值归 agent 配置，
 * Thinking 按 agent + model 由桌面组合层在表交付前对齐，批准姿态走显式端口。这里
 * 最终仍只保存 agent 答复的权威表。
 *
 * 这台 store 与 SessionControlsStore 同一个形制：依赖构造时交进来、订阅与退订成对
 * 交给 start()、写按 scope 串行、失败落进快照。两者唯一的差别是寻址 —— 那一台按
 * threadId，这一台按 agent，因为入口那一格既没有对话也没有会话，而选择器在那里
 * 必须画得出来。
 */

const NO_CONTROLS: readonly SessionConfigControl[] = []

/* 引用固定，#commit 才判得出「名册没变」。 */
const NO_TOOLKIT: AgentToolkit = { skills: [], mcpServers: [] }

/** 屏幕上那一格：agent 报的整张表，以及它说不出话时的理由。 */
export interface AgentControls {
  readonly controls: readonly SessionConfigControl[]
  readonly failure: string | undefined
  /** 这一家此刻公布的、人指名调用得到的技能与 MCP 名册。与表同一台 store。 */
  readonly toolkit: AgentToolkit
}

const EMPTY: AgentControls = {
  controls: NO_CONTROLS,
  failure: undefined,
  toolkit: NO_TOOLKIT,
}

/*
 * 读不到，和改不动，是两件事。
 *
 * 共用一个回调时，一次被拒的改动会顶着「没能读到可用的模型，去看看密钥填了没有」
 * 上屏 —— 把人支去检查一把本来就是对的钥匙。让人去修没坏的东西，是错误模型能犯
 * 的最贵的一种错。
 *
 * 这两个回调是给日志与降级用的，不是给屏幕用的：屏幕读的是快照里的 failure，因为
 * 那一格要能被再试一次，而一声通知按定义是过去式。
 */
export interface CapabilityFailureReport {
  /** 读整张表没成。屏幕上一个选项都没有。 */
  readonly readFailed: (cause: unknown) => void
  /** 改一项没成。表还在，只是这一次没生效。 */
  readonly changeFailed: (cause: unknown) => void
}

export interface AgentCapabilityOptions {
  /** 批准方式的持久意图。缺席即不对齐，这台 store 因此仍能裸构造单测。 */
  readonly posture?: PermissionPosturePort | undefined
  readonly report?: CapabilityFailureReport | undefined
}

/**
 * 一家 agent 的锚会话表。
 *
 * 它不认识 React、不认识进程，也不认识 IPC：端口由 start() 交进来，失败上报由构造
 * 时交进来，所以测试能各造一份自己的来跑，用例之间没有先后可言。
 */
export class AgentCapabilityStore {
  readonly #posture: PermissionPosturePort | undefined

  readonly #report: CapabilityFailureReport | undefined

  /* 唯一的状态。引用只在真的变了时才更换，useSyncExternalStore 要的就是这个稳定性。 */
  #held: AgentControls = EMPTY

  #listeners = new Set<() => void>()

  #source: AgentCapabilityPort | undefined

  /* 问过就不再问第二遍：重读是显式动作（refresh），不是渲染的副作用。 */
  #asked = false

  /* 名册按会话回答，所以它连地址一起记：地址变了就重读，没变就不再问。 */
  #toolkitAt: string | null = null

  #toolkitAsked: string | null | undefined

  /*
   * 这一家此刻在飞的那一次改动，同时是它的队伍。
   *
   * 串行不是为了省往返：agent 的答复才是下一步的判据，并发发出去的第二条命令用的
   * 是一张已经作废的表 —— 而这里那张作废的表还带着 purpose，桌面那一侧正是靠它
   * 决定往 config.toml 的 default_model 写什么（见 apps/desktop 的 agent-session.ts）。
   */
  #inflight: Promise<void> = Promise.resolve()

  /* read 与 select 都在飞时，该赢的是问得晚的那一个。规则与对话那一侧同一条。 */
  #order = new ArrivalOrder()

  /*
   * 已经为哪一个意图补发过对齐。同一个意图不补第二次：改动被拒会 refresh 回权威
   * 表，而那正是 #align 再次被叫到的时刻 —— 不记这一格就是一个自己喂自己的循环。
   */
  #alignedTo: string | undefined

  constructor({ posture, report }: AgentCapabilityOptions = {}) {
    this.#posture = posture
    this.#report = report
  }

  /** 屏幕上那一格。 */
  snapshot = (): AgentControls => this.#held

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)

    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 认下一个端口，开始听它说话，并交回停下来的办法。
   *
   * 订阅与退订成对地交给 effect，是 React 对这件事自己的答案：装载几次就订阅几次、
   * 退订几次，不可能配不平。换一家 agent 就是换一个端口，也就是同一个 effect 的一次
   * 清理加一次重装 —— 旧表当场作废，不留给下一家看。
   */
  start = (port: AgentCapabilityPort): (() => void) => {
    this.#source = port
    this.#asked = false
    this.#toolkitAt = null
    this.#toolkitAsked = undefined
    this.#alignedTo = undefined

    /* 换一家就是换一个端口：上一家排着的改动当场作废，不许再发出去。 */
    this.#inflight = Promise.resolve()

    this.#commit(EMPTY)

    /*
     * agent 一改主意就重读。
     *
     * 重读，而不是把推来的表直接吃下：那一声没带可判定的归属，而锚会话此刻握着
     * 什么，驱动器手上那张就是它最近一次的原话（driver.rs 的 Command::Selectors）。
     */
    const stop = port.subscribe(() => {
      this.refresh()
    })

    this.#load()
    this.#loadToolkit()

    return () => {
      stop()

      if (this.#source === port) {
        this.#source = undefined
      }
    }
  }

  /**
   * 在锚会话上改一项设置，排在这一家自己的队伍后面。
   *
   * agent 从没提供过的值不下发：候选集由它说了算，发一个它给不出的值只会换回一个
   * 错误。答复就是改完之后的整张表，原样存下。
   */
  selectControl = (controlId: string, value: string): void => {
    const port = this.#source

    if (port === undefined) {
      return
    }

    this.#inflight = this.#inflight.then(async () => {
      /*
       * 端口与判据都在出发前一刻现读：队伍里的第二条命令是在第一条的答复到达之后
       * 才出发的，而这中间可能已经换过一家 agent，表也可能已经变了。用闭包里那张
       * 旧表出发，它带着的 purpose 会让桌面那一侧往 default_model 写下一个已经
       * 不属于当前这一家的别名。
       */
      if (this.#source !== port) {
        return
      }

      const control = this.#held.controls.find((offered) => offered.id === controlId)

      if (control === undefined || control.current === value) {
        return
      }

      if (!control.choices.some((choice) => choice.value === value)) {
        return
      }

      /*
       * 批准方式同时是一个跨会话的决定，所以这一次点击既发给锚会话，也落成持久
       * 意图。写在发出之前，与 default_model 同一条顺序。
       */
      if (isPermissionPostureChange(control, value)) {
        this.#posture?.write(value)
        this.#alignedTo = value
      }

      const ticket = this.#order.issue()

      try {
        /*
         * 交出去的是整个控件。
         *
         * 端口的签名就是这么定的，理由写在 ./agent 的 capability.ts：
         * 桌面那一侧要靠 purpose 认出「模型那一格」才会去写 config.toml 的
         * default_model，而 id 是 agent 自己起的名字，协议没规定过。传一个字符串过去，
         * purpose 与 configId 一起读出 undefined —— 前者让换模型不再落盘，后者让命令
         * 在原生侧连反序列化都过不了。
         */
        this.#adopt(port, ticket, await port.select(control, value))
      } catch (cause: unknown) {
        this.#report?.changeFailed(cause)
        this.#note(cause)

        /* 改不动就退回驱动器手上那张表：它是这条连接最近一次记下的原话。 */
        this.refresh()
      }
    })
  }

  /**
   * 名册跟着这一格的会话走：入口那一格是 null（锚会话），进了对话就是那条对话。
   *
   * kap 按会话回答名册，而技能分层按工作目录。问锚会话、把技能发往对话的会话，
   * 屏幕上就会有一条它自己也调不动的技能。
   */
  adoptToolkit = (threadId: string | null): void => {
    if (this.#toolkitAt === threadId) {
      return
    }

    this.#toolkitAt = threadId
    this.#toolkitAsked = undefined
    this.#loadToolkit()
  }

  /** 显式重读一次。 */
  refresh = (): void => {
    this.#asked = false
    this.#toolkitAsked = undefined
    this.#load()
    this.#loadToolkit()
  }

  /* 一张表到了。端口和号都得对得上，否则它属于一个已经过去的问题。 */
  #adopt(port: AgentCapabilityPort, ticket: number, table: readonly SessionConfigControl[]): void {
    if (this.#source !== port || !this.#order.isLatest(ticket)) {
      return
    }

    this.#commit({ ...this.#held, controls: table, failure: undefined })
    this.#align(table)
  }

  /*
   * 让锚会话回到用户上次选的那个批准方式。
   *
   * 理由与 SessionControlsStore 的 #align 同一条：ACP 的 session/new 不带配置参数，
   * 持久意图只能在表到达之后补一次。补发走 selectControl，所以「发出 set_config」
   * 仍然只有一条路。
   */
  #align(table: readonly SessionConfigControl[]): void {
    const decision = pendingPostureAlignment(table, this.#posture?.read())

    if (decision === undefined || this.#alignedTo === decision.wanted) {
      return
    }

    this.selectControl(decision.control.id, decision.wanted)
  }

  /* 读一次整张表。没有端口就没有产地；问过了就不再问 —— 重读走 refresh。 */
  #load(): void {
    const port = this.#source

    if (port === undefined || this.#asked) {
      return
    }

    this.#asked = true

    const ticket = this.#order.issue()

    void port.read().then(
      (table) => {
        this.#adopt(port, ticket, table)
      },
      (cause: unknown) => {
        /* 失败不算问过：那一格要能被再试一次。 */
        this.#asked = false
        this.#report?.readFailed(cause)
        this.#note(cause)
      },
    )
  }

  /*
   * 失败落进快照，不只落进日志。
   *
   * 屏幕上那一格是可撤销的状态，不是一条记录：读不到时它要说出理由并且能被再试一次
   * （见 @poietica/surfaces 的 conversation/ 的 session-controls.tsx，空表与失败是两种不同的画法）。
   */
  #note(cause: unknown): void {
    this.#commit({ ...this.#held, failure: describeFailure(cause) })
  }

  /*
   * 名册读一次。
   *
   * 与那张表同一条纪律：没有端口就没有产地，问过了不再问，重读走 refresh；
   * 失败不算问过，那一格要能被再试一次。它不写 failure —— 屏幕上那一格说的是
   * 「可调项读没读到」，名册读不到不是那件事。
   */
  #loadToolkit(): void {
    const port = this.#source
    const at = this.#toolkitAt

    if (port === undefined || this.#toolkitAsked === at) {
      return
    }

    this.#toolkitAsked = at

    void port.readToolkit(at).then(
      (toolkit) => {
        if (this.#source === port && this.#toolkitAt === at) {
          this.#commit({ ...this.#held, toolkit })
        }
      },
      (cause: unknown) => {
        if (this.#toolkitAsked === at) {
          this.#toolkitAsked = undefined
        }

        this.#report?.readFailed(cause)
      },
    )
  }

  /*
   * 换一份状态，然后叫一声。
   *
   * 没变就不叫：两格都相同意味着这次提交什么都没改，而每一声都是一次重画。
   */
  #commit(next: AgentControls): void {
    if (
      next.controls === this.#held.controls &&
      next.failure === this.#held.failure &&
      next.toolkit === this.#held.toolkit
    ) {
      return
    }

    this.#held = next

    for (const listener of this.#listeners) {
      listener()
    }
  }
}
