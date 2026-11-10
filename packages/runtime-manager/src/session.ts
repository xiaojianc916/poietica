import type { TranscriptPage } from '@poietica/agent-model'
import type { Disposable } from '@poietica/foundation'
import type {
  Controls,
  EngineSession,
  EngineSessionEvent,
  Interaction,
  InteractionAnswer,
  ModelRef,
  OpenSessionSpec,
  PageOptions,
  Posture,
  QueueSnapshot,
  SessionState,
  SideTopic,
  SlashCommand,
  SubmitInput,
} from '@poietica/runtime-protocol'
import { arpMethods, arpSessionSnapshotResult } from '@poietica/runtime-protocol'

type Request = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>

/**
 * ARP 会话客户端：异步方法走 `session.call`，同步读数用事件维护的缓存。
 * 与 Worker 里的 EngineSession 一一对应；Core 不需要 import 任何 omp 实现。
 */
export class ArpSession implements EngineSession {
  readonly sessionId: string
  readonly sessionFile: string
  private stateValue: SessionState
  private busyValue: boolean
  private queueValue: QueueSnapshot
  private controlsValue: Controls
  private interactionsValue: Interaction[]
  private readonly listeners = new Set<(event: EngineSessionEvent) => void>()
  private disposed = false

  private constructor(
    private readonly key: string,
    private readonly request: Request,
    opened: { sessionId: string; sessionFile: string },
    snapshot: ReturnType<typeof arpSessionSnapshotResult.parse>,
    private readonly onError: (error: unknown) => void,
  ) {
    this.sessionId = opened.sessionId
    this.sessionFile = opened.sessionFile
    this.stateValue = snapshot.state
    this.busyValue = snapshot.busy
    this.queueValue = snapshot.queue
    this.controlsValue = snapshot.controls
    this.interactionsValue = [...snapshot.interactions]
  }

  static async open(o: {
    spec: OpenSessionSpec
    request: Request
    onError: (error: unknown) => void
  }): Promise<ArpSession> {
    const opened = (await o.request(arpMethods.sessionOpen, o.spec)) as { sessionId: string; sessionFile: string }
    const snapshot = arpSessionSnapshotResult.parse(await o.request(arpMethods.sessionSnapshot, { key: o.spec.key }))
    return new ArpSession(o.spec.key, o.request, opened, snapshot, o.onError)
  }

  state(): SessionState {
    return this.stateValue
  }

  isBusy(): boolean {
    return this.busyValue
  }

  subscribe(listener: (event: EngineSessionEvent) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  dispatch(event: EngineSessionEvent): void {
    if (event.type === 'state') {
      this.stateValue = event.state
      this.busyValue = event.state !== 'idle'
    } else if (event.type === 'queue') {
      this.queueValue = event.queue
    } else if (event.type === 'controls') {
      this.controlsValue = event.controls
    } else if (event.type === 'interactionRequested') {
      const index = this.interactionsValue.findIndex((item) => item.id === event.interaction.id)
      if (index >= 0) this.interactionsValue[index] = event.interaction
      else this.interactionsValue.push(event.interaction)
    } else if (event.type === 'interactionResolved') {
      this.interactionsValue = this.interactionsValue.filter((item) => item.id !== event.interactionId)
    }
    for (const listener of [...this.listeners]) listener(event)
  }

  private call(method: string, args: readonly unknown[], timeoutMs = 30_000): Promise<unknown> {
    return this.request(arpMethods.sessionCall, { key: this.key, method, args }, timeoutMs)
  }

  private fire(method: string, args: readonly unknown[]): void {
    void this.call(method, args).catch(this.onError)
  }

  async submit(input: SubmitInput): Promise<void> {
    await this.call('submit', [input], 0)
  }
  async cancel(): Promise<void> {
    await this.call('cancel', [])
  }
  queue(): QueueSnapshot {
    return this.queueValue
  }
  withdraw(queueItemId: string): void {
    this.fire('withdraw', [queueItemId])
  }
  async moveQueued(queueItemId: string, deliverAs: 'steer' | 'followUp'): Promise<void> {
    await this.call('moveQueued', [queueItemId, deliverAs])
  }
  setQueueModes(modes: Partial<QueueSnapshot['modes']>): void {
    this.fire('setQueueModes', [modes])
  }
  controls(): Controls {
    return this.controlsValue
  }
  async setModel(model: ModelRef): Promise<void> {
    await this.call('setModel', [model])
  }
  setThinking(level: string): void {
    this.fire('setThinking', [level])
  }
  setPosture(posture: Posture): void {
    this.fire('setPosture', [posture])
  }
  async setPlanMode(enabled: boolean): Promise<void> {
    await this.call('setPlanMode', [enabled])
  }
  async setGoal(goal: string | null): Promise<void> {
    await this.call('setGoal', [goal])
  }
  async pauseGoal(): Promise<void> {
    await this.call('pauseGoal', [])
  }
  async resumeGoal(): Promise<void> {
    await this.call('resumeGoal', [])
  }
  async rename(title: string): Promise<void> {
    await this.call('rename', [title])
  }
  async commands(): Promise<readonly SlashCommand[]> {
    return (await this.call('commands', [])) as readonly SlashCommand[]
  }
  async runCommand(text: string): Promise<void> {
    await this.call('runCommand', [text], 0)
  }
  interactions(): readonly Interaction[] {
    return this.interactionsValue
  }
  respond(interactionId: string, answer: InteractionAnswer): void {
    this.fire('respond', [interactionId, answer])
  }
  async page(agentId: string, beforeTurnId: string | null, options?: PageOptions): Promise<TranscriptPage> {
    return (await this.call('page', [agentId, beforeTurnId, options])) as TranscriptPage
  }
  async cancelSubagent(agentId: string): Promise<boolean> {
    return (await this.call('cancelSubagent', [agentId])) as boolean
  }
  async steerSubagent(agentId: string, text: string): Promise<void> {
    await this.call('steerSubagent', [agentId, text])
  }
  async cancelBackgroundTask(taskId: string): Promise<boolean> {
    return (await this.call('cancelBackgroundTask', [taskId])) as boolean
  }
  async askSide(question: string, topicId: string | null): Promise<SideTopic> {
    return (await this.call('askSide', [question, topicId])) as SideTopic
  }
  cancelSide(topicId: string | null): boolean {
    this.fire('cancelSide', [topicId])
    return true
  }
  async sideTopics(): Promise<readonly SideTopic[]> {
    return (await this.call('sideTopics', [])) as readonly SideTopic[]
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    await this.request(arpMethods.sessionClose, { key: this.key }).catch(this.onError)
  }
}
