import type { AgentEngine, EngineSession, EngineSessionEvent, OpenSessionSpec } from '@poietica/engine'
import { AppError, type Clock, Deferred, type Disposable, type Logger, SystemErrorCode } from '@poietica/foundation'

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

/** 正在打开的槽位：`promise` 由 deferred 驱动，槽位一定先于 `open()` 的第一个 await 进表 */
interface OpeningSlot {
  readonly phase: 'opening'
  readonly generation: number
  readonly promise: Promise<EngineSession>
  /** release / dispose 在打开期间被调用：打开完成后立刻丢弃 */
  cancelled: boolean
}

interface LiveSlot {
  readonly phase: 'live'
  readonly generation: number
  readonly session: EngineSession
  readonly subscription: Disposable
  lastUsed: number
}

type Slot = OpeningSlot | LiveSlot

/**
 * 线程 → 活的 omp 会话（R-03 §2.2 的槽位状态机：opening → live → 释放后槽位消失）。
 *
 * 所有操作都对**槽位**说话，而不是分开查「已打开」与「正在打开」两张表：
 * - 懒打开：第一次需要时才打开；同一线程并发 acquire 只打开一次；
 * - 释放一个打开中的槽位 = 取消：等打开结束后立刻 dispose，等待的 acquire 得到 kernel.cancelled；
 * - 配置变更换代（invalidate）：空闲的立刻释放，忙的与打开中的在第一次空闲时释放；
 * - 忙（运行中或有待答交互）的会话永不驱逐；
 * - 空闲超过 10 分钟，或空闲会话超过 6 个时，按最久未用驱逐。
 */
export class SessionPool implements Disposable {
  private readonly slots = new Map<string, Slot>()
  /** 配置代号：每次 invalidate() +1，槽位记住自己是哪一代打开的 */
  private generation = 0
  private disposed = false
  private readonly timer: Disposable

  constructor(private readonly d: SessionPoolDeps) {
    this.timer = d.clock.setInterval(() => {
      void this.sweep()
    }, SWEEP_INTERVAL_MS)
  }

  peek(threadId: string): EngineSession | undefined {
    const slot = this.slots.get(threadId)
    return slot?.phase === 'live' ? slot.session : undefined
  }

  /** 这条线程此刻正在打开（还没有会话可 peek） */
  isOpening(threadId: string): boolean {
    return this.slots.get(threadId)?.phase === 'opening'
  }

  async acquire(threadId: string): Promise<EngineSession> {
    if (this.disposed) throw new AppError(SystemErrorCode.cancelled, '会话池已关闭')
    const slot = this.slots.get(threadId)
    if (slot?.phase === 'live') {
      // 旧代、且空闲：先释放再按新配置重开（正常路径在 state=idle 时已经释放过了）
      if (slot.generation !== this.generation && !slot.session.isBusy()) {
        await this.release(threadId)
        return await this.acquire(threadId)
      }
      slot.lastUsed = this.d.clock.now()
      return slot.session
    }
    if (slot?.phase === 'opening') {
      if (!slot.cancelled) return slot.promise
      // 取消中的打开：等它收尾，再开一条新的（不能把被取消的那条交出去）
      await slot.promise.catch(() => undefined)
      return await this.acquire(threadId)
    }
    return this.startOpening(threadId)
  }

  async release(threadId: string): Promise<void> {
    const slot = this.slots.get(threadId)
    if (slot === undefined) return
    if (slot.phase === 'opening') {
      // 打开中的释放 = 取消：open() 自己会 dispose 并删槽位，返回时会话一定已经不存在
      slot.cancelled = true
      await slot.promise.catch(() => undefined)
      return
    }
    this.slots.delete(threadId)
    slot.subscription.dispose()
    await this.disposeQuietly(threadId, slot.session)
    this.d.onReleased(threadId)
  }

  /**
   * 配置变了（设置 / 模型目录 / 技能）：换代。
   *
   * 空闲的立刻释放；忙的与打开中的带着旧代号进入 live，在第一次空闲时由
   * `onSessionEvent` 释放 —— 只释放一次「空闲」是不够的：一轮跑完就再没人管它了。
   */
  async invalidate(): Promise<void> {
    this.generation += 1
    for (const [threadId, slot] of [...this.slots]) {
      if (slot.phase === 'live' && !slot.session.isBusy()) await this.release(threadId)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.timer.dispose()
    // 并发释放是有意的：退出时串行 dispose 多条会话会把退出拖长；退出总超时在 host-kernel。
    await Promise.all([...this.slots.keys()].map((threadId) => this.release(threadId)))
  }

  private startOpening(threadId: string): Promise<EngineSession> {
    const deferred = new Deferred<EngineSession>()
    const slot: OpeningSlot = {
      phase: 'opening',
      generation: this.generation,
      promise: deferred.promise,
      cancelled: false,
    }
    // 槽位先于 open() 的第一个 await 进表：打开期间到来的 release / dispose 一定看得见它
    this.slots.set(threadId, slot)
    void this.open(threadId, slot).then(
      (session) => deferred.resolve(session),
      (error: unknown) => deferred.reject(error),
    )
    return deferred.promise
  }

  private async open(threadId: string, opening: OpeningSlot): Promise<EngineSession> {
    let session: EngineSession
    try {
      // describe() 在第一个 await 之前同步调用；它抛出（行已删、工作区不可用）也删槽位
      session = await this.d.engine.openSession(this.d.describe(threadId))
    } catch (error) {
      this.dropSlot(threadId, opening)
      throw error
    }
    // 打开期间被取消（删线程 / 退出 / 释放）：直接丢弃，不绑行、不进池
    if (opening.cancelled || this.disposed) {
      this.dropSlot(threadId, opening)
      await this.disposeQuietly(threadId, session)
      throw new AppError(SystemErrorCode.cancelled, '会话已关闭')
    }
    let live: LiveSlot | undefined
    const subscription = session.subscribe((event) => {
      this.onSessionEvent(threadId, live, event)
    })
    try {
      this.d.onOpened(threadId, session)
    } catch (error) {
      subscription.dispose()
      this.dropSlot(threadId, opening)
      await this.disposeQuietly(threadId, session)
      throw error
    }
    live = {
      phase: 'live',
      generation: opening.generation,
      session,
      subscription,
      lastUsed: this.d.clock.now(),
    }
    this.slots.set(threadId, live)
    await this.evictOverflow(threadId)
    return session
  }

  /**
   * 会话事件：先原样转给路由；旧代会话回到 idle 时按新配置换代。
   *
   * microtask 是为了让同一条 state 事件的其它处理先完成；再核对一次槽位身份与忙碌状态，
   * 免得在让出之后把别人刚开的会话（或又忙起来的同一条会话）释放掉。
   */
  private onSessionEvent(threadId: string, slot: LiveSlot | undefined, event: EngineSessionEvent): void {
    this.d.onEvent(threadId, event)
    if (slot === undefined || event.type !== 'state' || event.state !== 'idle') return
    if (slot.generation === this.generation) return
    queueMicrotask(() => {
      if (this.slots.get(threadId) !== slot || slot.generation === this.generation || slot.session.isBusy()) return
      void this.release(threadId)
    })
  }

  /** 只在槽位没被换掉时删表（并发的 release / acquire 之后不要误删新槽位） */
  private dropSlot(threadId: string, slot: Slot): void {
    if (this.slots.get(threadId) === slot) this.slots.delete(threadId)
  }

  private async disposeQuietly(threadId: string, session: EngineSession): Promise<void> {
    await session
      .dispose()
      .catch((err: unknown) => this.d.logger.warn('session dispose failed', { threadId, error: String(err) }))
  }

  private async sweep(): Promise<void> {
    const now = this.d.clock.now()
    for (const [threadId, slot] of [...this.slots]) {
      if (slot.phase !== 'live' || slot.session.isBusy()) continue
      // 旧代且空闲的一并释放：忙会话错过了 invalidate 的那一次，这里兜住
      if (slot.generation !== this.generation || now - slot.lastUsed > IDLE_TTL_MS) await this.release(threadId)
    }
  }

  private async evictOverflow(keep: string): Promise<void> {
    const idle = [...this.slots]
      .filter((entry): entry is [string, LiveSlot] => entry[1].phase === 'live' && !entry[1].session.isBusy())
      .filter(([id]) => id !== keep)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    while (idle.length > MAX_IDLE_SESSIONS) {
      const [threadId] = idle.shift()!
      await this.release(threadId)
    }
  }
}
