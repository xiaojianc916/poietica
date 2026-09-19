import type { AgentCapabilityPort } from '../agent/capability'
import type { SessionConfigControl, SessionConfigMemoryPort } from '../agent/config'
import type { PermissionPosturePort } from '../agent/permission'
import type { AgentToolkit } from '../agent/toolkit'
import { describeFailure } from '../failure'
import { ArrivalOrder } from './arrival-order'
import {
  isPermissionPostureChange,
  pendingPostureAlignment,
  projectPosture,
} from './permission-posture'

export interface AgentControls {
  readonly controls: readonly SessionConfigControl[]
  readonly failure: string | undefined
  readonly toolkit: AgentToolkit
  /**
   * 屏幕上这张表还没有被 agent 确认过。
   *
   * 只有一种来源会置真：开窗时从盘上读回来的上一趟那份。agent 的任何一次答复
   * （read / select / 主动上报）落地都把它清成假。
   */
  readonly provisional: boolean
}
export interface CapabilityFailureReport {
  readonly readFailed: (cause: unknown) => void
  readonly changeFailed: (cause: unknown) => void
}
export interface AgentCapabilityOptions {
  readonly posture?: PermissionPosturePort | undefined
  readonly report?: CapabilityFailureReport | undefined
  /** 上一趟那张表。缺席即第一帧空白，与从前一样。 */
  readonly memory?: SessionConfigMemoryPort | undefined
}
interface ToolkitRequest {
  readonly at: string | null
}
interface Binding {
  readonly port: AgentCapabilityPort
  readonly order: ArrivalOrder
  tail: Promise<void>
  alignedTo: string | undefined
  /** agent 这一趟报的原话，用来判「还要不要再发一次」。屏幕上那张可能被投影过。 */
  reported: readonly SessionConfigControl[] | undefined
  toolkitAt: string | null
  toolkitRequest: ToolkitRequest | undefined
}
const EMPTY: AgentControls = {
  controls: [],
  failure: undefined,
  toolkit: { skills: [], mcpServers: [] },
  provisional: false,
}
function userVisibleToolkit(toolkit: AgentToolkit): AgentToolkit {
  const skills = toolkit.skills.filter((skill) => skill.source !== 'builtin')
  return skills.length === toolkit.skills.length ? toolkit : { ...toolkit, skills }
}

export class AgentCapabilityStore {
  readonly #posture: PermissionPosturePort | undefined
  readonly #report: CapabilityFailureReport | undefined
  readonly #memory: SessionConfigMemoryPort | undefined
  readonly #listeners = new Set<() => void>()
  #held: AgentControls = EMPTY
  #binding: Binding | undefined
  #stop: (() => void) | undefined
  constructor({ memory, posture, report }: AgentCapabilityOptions = {}) {
    this.#memory = memory
    this.#posture = posture
    this.#report = report
    /*
     * 读一次就定下来：这是「上一次开窗时那张表」，本趟运行里它不会再变，所以不必
     * 跟着 start 反复读 —— 每次 start 都重读反而会让已经确认过的表退回未确认态。
     *
     * 读失败按没有记忆处置，不上报：它只影响第一帧好不好看。
     */
    try {
      const remembered = memory?.read() ?? []
      if (remembered.length > 0) {
        this.#held = { ...EMPTY, controls: remembered, provisional: true }
      }
    } catch {
      this.#held = EMPTY
    }
  }
  snapshot = (): AgentControls => this.#held
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  start = (port: AgentCapabilityPort): (() => void) => {
    this.#stop?.()
    const binding: Binding = {
      port,
      order: new ArrivalOrder(),
      tail: Promise.resolve(),
      alignedTo: undefined,
      reported: undefined,
      toolkitAt: null,
      toolkitRequest: undefined,
    }
    let active = true
    let unsubscribe: (() => void) | undefined
    const stop = (): void => {
      if (!active) {
        return
      }
      active = false
      // Invalidate ownership before calling external cleanup.
      if (this.#binding === binding) {
        this.#binding = undefined
        this.#stop = undefined
      }
      unsubscribe?.()
    }
    this.#binding = binding
    this.#stop = stop
    try {
      /*
       * 盘上那份留着上屏，直到 agent 真的答了一次。这里清掉它，第一帧就退回空白 ——
       * 那正是这次改动要消掉的东西。
       */
      if (!this.#held.provisional) {
        this.#commit(EMPTY)
      }
      if (this.#binding !== binding) {
        return stop
      }
      unsubscribe = port.subscribe(() => {
        if (this.#binding === binding) {
          void this.refresh()
        }
      })
      if (!active || this.#binding !== binding) {
        unsubscribe()
      } else {
        void this.refresh()
      }
    } catch (cause: unknown) {
      try {
        stop()
      } catch (cleanup: unknown) {
        throw new AggregateError(
          [cause, cleanup],
          'Capability subscription failed to start and stop',
        )
      }
      throw cause
    }
    return stop
  }
  selectControl = (controlId: string, value: string): void => {
    const binding = this.#binding
    if (binding === undefined) {
      return
    }
    /*
     * 盘上那份读回来的表不是可下发的判据：它答的是「上一次是什么样」。据此发一条
     * set_config，改的可能正是 agent 这一趟已经不提供的那一档。
     *
     * 闸放在这里而不是各个按钮上：下发只有这一个出口，逐处禁用总会漏掉一处
     * （面板里的模式行就不是那三颗工具条控件）。
     */
    if (this.#held.provisional) {
      return
    }
    this.#send(binding, controlId, value)
  }
  adoptToolkit = (threadId: string | null): void => {
    const binding = this.#binding
    if (binding === undefined || binding.toolkitAt === threadId) {
      return
    }
    binding.toolkitAt = threadId
    binding.toolkitRequest = undefined
    this.#loadToolkit(binding)
  }
  /*
   * 重读这一家的可调项。失败那一格不由这里清（由拿到表的 #adopt 清），所以点了重试
   * 之后那句话会留到这一趟落地；交回的承诺决定那颗重试图标转多久。
   */
  refresh = (): Promise<void> => {
    const binding = this.#binding
    if (binding === undefined) {
      return Promise.resolve()
    }
    binding.toolkitRequest = undefined
    const loaded = this.#load(binding)
    this.#loadToolkit(binding)
    return loaded
  }
  #adopt(binding: Binding, ticket: number, controls: readonly SessionConfigControl[]): void {
    if (this.#binding !== binding || !binding.order.isLatest(ticket)) {
      return
    }
    /*
     * agent 这一趟的原话单独记一份。
     *
     * 屏幕上画的那张可能被投影过（见下面 aligning），而「要不要再发一次」必须拿原话
     * 判 —— 投影过的 current 已经是要收敛到的那个值，再拿它当判据，同值早退会把这次
     * 补发整个吞掉：屏幕显示完全访问，agent 那头还停在请求批准。
     */
    const decision = pendingPostureAlignment(controls, this.#posture?.read())
    /* 真要补发的那一次；同一个值发过就不再发（那正是 agent 拒了之后的形状）。 */
    const aligning =
      decision !== undefined && binding.alignedTo !== decision.wanted ? decision : undefined
    /*
     * 补发已经在路上时画的是要收敛到的那一档，不是 agent 这一趟报的中间值。
     *
     * 新会话默认报 manual，而用户上次选的是 auto：照原样画就会先闪一下「请求批准」，
     * 下一趟往返再跳回「完全访问」。那一闪是一个用户从没选过、也马上要被覆盖的值。
     */
    const shown = aligning === undefined ? controls : projectPosture(controls, aligning)
    binding.reported = controls
    this.#commit({ ...this.#held, controls: shown, failure: undefined, provisional: false })
    /*
     * 存的是这一趟画出来的那张表。
     *
     * 补发在路上时它就是下一趟该看到的第一帧 —— 存 agent 原话会让下一次开窗先画那个
     * 中间值、再闪回收敛值，同一个问题换个方向再来一遍。agent 真的拒了那次改动时这里
     * 存的就是它报的那一张（见上面的 aligning 判据），所以盘上那份终究会收敛到事实。
     */
    this.#memory?.write(shown)
    if (this.#binding !== binding) {
      return
    }
    if (aligning !== undefined) {
      this.#send(binding, aligning.control.id, aligning.wanted)
    }
  }
  /*
   * 下发一次改动，判据是 agent 的原话。
   *
   * 补发对齐与用户点击共用这一条路（selectControl 只多两件事：provisional 闸与
   * 批准方式的持久意图）。
   */
  #send(binding: Binding, controlId: string, value: string): void {
    binding.tail = binding.tail.then(async () => {
      if (this.#binding !== binding) {
        return
      }
      const control = this.#held.controls.find((offered) => offered.id === controlId)
      if (
        control === undefined ||
        !control.choices.some((choice) => choice.value === value) ||
        /* 同值早退拿的是 agent 报的那个 current，不是屏幕上投影过的。 */
        this.#authoritative(binding, controlId) === value
      ) {
        return
      }
      const ticket = binding.order.issue()
      try {
        if (isPermissionPostureChange(control, value)) {
          this.#posture?.write(value)
          binding.alignedTo = value
        }
        this.#adopt(binding, ticket, await binding.port.select(control, value))
      } catch (cause: unknown) {
        if (this.#binding !== binding || !binding.order.isLatest(ticket)) {
          return
        }
        this.#note(cause)
        this.#report?.changeFailed(cause)
        if (this.#binding === binding) {
          void this.refresh()
        }
      }
    })
  }
  /* agent 这一趟报的那个值。没报过就是 undefined。 */
  #authoritative(binding: Binding, controlId: string): string | undefined {
    return binding.reported?.find((control) => control.id === controlId)?.current
  }
  async #load(binding: Binding): Promise<void> {
    const ticket = binding.order.issue()
    try {
      this.#adopt(binding, ticket, await binding.port.read())
    } catch (cause: unknown) {
      if (this.#binding !== binding || !binding.order.isLatest(ticket)) {
        return
      }
      this.#note(cause)
      this.#report?.readFailed(cause)
    }
  }
  #loadToolkit(binding: Binding): void {
    if (this.#binding !== binding || binding.toolkitRequest?.at === binding.toolkitAt) {
      return
    }
    const request: ToolkitRequest = { at: binding.toolkitAt }
    binding.toolkitRequest = request
    const owned = (): boolean => this.#binding === binding && binding.toolkitRequest === request
    const read = async (): Promise<void> => {
      try {
        const toolkit = await binding.port.readToolkit(request.at)
        if (owned()) {
          this.#commit({ ...this.#held, toolkit: userVisibleToolkit(toolkit) })
        }
      } catch (cause: unknown) {
        if (!owned()) {
          return
        }
        binding.toolkitRequest = undefined
        this.#report?.readFailed(cause)
      }
    }
    void read()
  }
  #note(cause: unknown): void {
    this.#commit({ ...this.#held, failure: describeFailure(cause) })
  }
  #commit(next: AgentControls): void {
    if (
      next.controls === this.#held.controls &&
      next.failure === this.#held.failure &&
      next.toolkit === this.#held.toolkit &&
      next.provisional === this.#held.provisional
    ) {
      return
    }
    this.#held = next
    for (const listener of this.#listeners) {
      listener()
    }
  }
}
