import type { AgentEngine, EngineSession, EngineSessionEvent, OpenSessionSpec } from '@poietica/engine'
import type { Clock, Disposable, Logger } from '@poietica/foundation'

export const MAX_IDLE_SESSIONS = 6
export const IDLE_TTL_MS = 10 * 60_000
export const SWEEP_INTERVAL_MS = 60_000

export interface SessionPoolDeps {
  readonly engine: AgentEngine
  readonly clock: Clock
  readonly logger: Logger
  /** 打开会话所需的参数（cwd、会话文件、姿态、初始模型） */
  describe(threadId: string): OpenSessionSpec
  /** 新会话第一次打开后回调：把 sessionId / sessionFile 绑定到线程行 */
  onOpened(threadId: string, session: EngineSession): void
  onEvent(threadId: string, event: EngineSessionEvent): void
  onReleased(threadId: string): void
}

interface Entry {
  readonly session: EngineSession
  lastUsed: number
  readonly subscription: Disposable
}

/**
 * 线程 → 活的 omp 会话。规则：
 * - 懒打开：第一次需要时才打开；同一线程并发 acquire 只打开一次；
 * - 忙（运行中或有待答交互）的会话永不驱逐；
 * - 空闲超过 10 分钟，或空闲会话超过 6 个时，按最久未用驱逐。
 */
export class SessionPool implements Disposable {
  private readonly live = new Map<string, Entry>()
  private readonly opening = new Map<string, Promise<EngineSession>>()
  private readonly timer: Disposable

  constructor(private readonly d: SessionPoolDeps) {
    this.timer = d.clock.setInterval(() => {
      void this.sweep()
    }, SWEEP_INTERVAL_MS)
  }

  peek(threadId: string): EngineSession | undefined {
    return this.live.get(threadId)?.session
  }

  async acquire(threadId: string): Promise<EngineSession> {
    const hit = this.live.get(threadId)
    if (hit !== undefined) {
      hit.lastUsed = this.d.clock.now()
      return hit.session
    }
    const inflight = this.opening.get(threadId)
    if (inflight !== undefined) return inflight
    const p = this.open(threadId).finally(() => this.opening.delete(threadId))
    this.opening.set(threadId, p)
    return p
  }

  async release(threadId: string): Promise<void> {
    const e = this.live.get(threadId)
    if (e === undefined) return
    this.live.delete(threadId)
    e.subscription.dispose()
    await e.session
      .dispose()
      .catch((err: unknown) => this.d.logger.warn('session dispose failed', { threadId, error: String(err) }))
    this.d.onReleased(threadId)
  }

  /** 设置 / 技能 / 插件变化后调用：空闲会话全部释放，下次使用时以新配置重建 */
  async releaseIdle(): Promise<void> {
    for (const [threadId, e] of [...this.live]) if (!e.session.isBusy()) await this.release(threadId)
  }

  async dispose(): Promise<void> {
    this.timer.dispose()
    for (const threadId of [...this.live.keys()]) await this.release(threadId)
  }

  private async open(threadId: string): Promise<EngineSession> {
    const spec = this.d.describe(threadId)
    const session = await this.d.engine.openSession(spec)
    const subscription = session.subscribe((event) => this.d.onEvent(threadId, event))
    this.live.set(threadId, { session, lastUsed: this.d.clock.now(), subscription })
    this.d.onOpened(threadId, session)
    await this.evictOverflow(threadId)
    return session
  }

  private async sweep(): Promise<void> {
    const now = this.d.clock.now()
    for (const [threadId, e] of [...this.live]) {
      if (!e.session.isBusy() && now - e.lastUsed > IDLE_TTL_MS) await this.release(threadId)
    }
  }

  private async evictOverflow(keep: string): Promise<void> {
    const idle = [...this.live]
      .filter(([id, e]) => id !== keep && !e.session.isBusy())
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    while (idle.length > MAX_IDLE_SESSIONS) {
      const [threadId] = idle.shift()!
      await this.release(threadId)
    }
  }
}
