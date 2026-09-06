import type { AgentCapabilityPort } from '../agent/capability'
import type { SessionConfigControl } from '../agent/config'
import type { PermissionPosturePort } from '../agent/permission'
import type { AgentToolkit } from '../agent/toolkit'
import { describeFailure } from '../failure'
import { ArrivalOrder } from './arrival-order'
import { isPermissionPostureChange, pendingPostureAlignment } from './permission-posture'

export interface AgentControls {
  readonly controls: readonly SessionConfigControl[]
  readonly failure: string | undefined
  readonly toolkit: AgentToolkit
}
export interface CapabilityFailureReport {
  readonly readFailed: (cause: unknown) => void
  readonly changeFailed: (cause: unknown) => void
}
export interface AgentCapabilityOptions {
  readonly posture?: PermissionPosturePort | undefined
  readonly report?: CapabilityFailureReport | undefined
}
interface ToolkitRequest {
  readonly at: string | null
}
interface Binding {
  readonly port: AgentCapabilityPort
  readonly order: ArrivalOrder
  tail: Promise<void>
  alignedTo: string | undefined
  toolkitAt: string | null
  toolkitRequest: ToolkitRequest | undefined
}
const EMPTY: AgentControls = {
  controls: [],
  failure: undefined,
  toolkit: { skills: [], mcpServers: [] },
}
function userVisibleToolkit(toolkit: AgentToolkit): AgentToolkit {
  const skills = toolkit.skills.filter((skill) => skill.source !== 'builtin')
  return skills.length === toolkit.skills.length ? toolkit : { ...toolkit, skills }
}

export class AgentCapabilityStore {
  readonly #posture: PermissionPosturePort | undefined
  readonly #report: CapabilityFailureReport | undefined
  readonly #listeners = new Set<() => void>()
  #held: AgentControls = EMPTY
  #binding: Binding | undefined
  #stop: (() => void) | undefined
  constructor({ posture, report }: AgentCapabilityOptions = {}) {
    this.#posture = posture
    this.#report = report
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
      this.#commit(EMPTY)
      if (this.#binding !== binding) {
        return stop
      }
      unsubscribe = port.subscribe(() => {
        if (this.#binding === binding) {
          this.refresh()
        }
      })
      if (!active || this.#binding !== binding) {
        unsubscribe()
      } else {
        this.refresh()
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
    binding.tail = binding.tail.then(async () => {
      if (this.#binding !== binding) {
        return
      }
      const control = this.#held.controls.find((offered) => offered.id === controlId)
      if (
        control === undefined ||
        control.current === value ||
        !control.choices.some((choice) => choice.value === value)
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
          this.refresh()
        }
      }
    })
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
  refresh = (): void => {
    const binding = this.#binding
    if (binding === undefined) {
      return
    }
    binding.toolkitRequest = undefined
    void this.#load(binding)
    this.#loadToolkit(binding)
  }
  #adopt(binding: Binding, ticket: number, controls: readonly SessionConfigControl[]): void {
    if (this.#binding !== binding || !binding.order.isLatest(ticket)) {
      return
    }
    this.#commit({ ...this.#held, controls, failure: undefined })
    if (this.#binding !== binding) {
      return
    }
    const decision = pendingPostureAlignment(controls, this.#posture?.read())
    if (decision !== undefined && binding.alignedTo !== decision.wanted) {
      this.selectControl(decision.control.id, decision.wanted)
    }
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
