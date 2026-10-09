import { EngineErrorCode, type Interaction, type InteractionAnswer } from '@poietica/engine'
import { AppError, createId, Emitter, type Event, SystemErrorCode } from '@poietica/foundation'

/** 去掉基类三格（id / createdAt / timeoutAt）的交互草稿；分配式，判别联合的每一支都保留 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 调用方给出的交互草稿：id 与两个时刻由 broker 现场签发 */
export type InteractionDraft = DistributiveOmit<Interaction, 'id' | 'createdAt' | 'timeoutAt'>

/** 一次变化：登记（requested）或收口（resolved） */
export interface InteractionChange {
  readonly type: 'requested' | 'resolved'
  /** 与 type 同义，给只关心「还有没有人在等」的调用方读 */
  readonly resolved: boolean
  /** 这张卡片。resolved 时仍是原交互，投影器据此把卡片改成已批准 / 已拒绝 / 已回答 / 已取消 */
  readonly interaction: Interaction
  readonly id: string
  /** 仅 resolved：这一次的答复。超时与 abort 也在内，都是 dismiss */
  readonly answer?: InteractionAnswer
}

export interface AskOptions {
  /** 毫秒；省略即不超时。timeoutAt 由注入的 now 算出，绝不用真实时钟 */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

type ToUpstream<T> = (answer: InteractionAnswer) => T

/** 唯一那个「没人答」的答复。共用一份，免得下游按对象身份比较时对不上 */
export const DISMISS: InteractionAnswer = Object.freeze({ kind: 'dismiss' })

/**
 * 待答交互的账本（04 页 §3.12、12 页 §8.1）。
 *
 * 三件事只在这里发生，写成一份就没有「Promise 结了但屏幕没被告知」的缝：
 * - 登记：签发 id、按注入的 now 算 createdAt / timeoutAt、记进表里、发 requested；
 * - 收口：答复、超时、中止三条路都走同一个 settle（先出表，再发 resolved，最后兑现）；
 * - 撤销：cancelAll 把还在等的全部以 dismiss 兑现（取消一轮、销毁会话时用）。
 *
 * id 与时刻都由这里签发：调用方给草稿，所以「谁在等、等了多久」只有一份账。
 */
export class InteractionBroker {
  private readonly waiting = new Map<string, Waiting>()
  /*
   * 监听者异常带上下文记一条 error（R-08-4）：这张桌子的变化订阅者有好几家（OmpSession、
   * 会话工厂），裸文本的 lastResort 看不出是谁的哪一种变化出的错。异常照旧不外抛。
   */
  private readonly changes: Emitter<InteractionChange>

  /** 变化订阅。omp 在自己的事件循环里调它；监听器异常由 Emitter 吞掉并交给注入的那条日志（12 页 §0.3） */
  readonly onChange: Event<InteractionChange>

  constructor(
    private readonly now: () => number,
    onListenerError?: (error: unknown) => void,
  ) {
    this.changes = new Emitter<InteractionChange>(onListenerError === undefined ? {} : { onListenerError })
    this.onChange = this.changes.event
  }

  /** 登记一次交互并等答复（04 页 §3.12 的原签名） */
  ask(draft: InteractionDraft, options?: AskOptions): Promise<InteractionAnswer>
  /** 登记并等答复，同时把答复翻成上游要的形状（ui-context 走这一支） */
  ask<T>(draft: InteractionDraft, toUpstream: ToUpstream<T>, options?: AskOptions): Promise<T>
  ask<T = InteractionAnswer>(
    draft: InteractionDraft,
    toUpstreamOrOptions?: ToUpstream<T> | AskOptions,
    options?: AskOptions,
  ): Promise<T | InteractionAnswer> {
    const toUpstream = typeof toUpstreamOrOptions === 'function' ? toUpstreamOrOptions : undefined
    const opts = toUpstream === undefined ? (toUpstreamOrOptions as AskOptions | undefined) : options
    const id = createId()
    const at = this.now()
    const interaction: Interaction = {
      ...draft,
      id,
      createdAt: at,
      timeoutAt: opts?.timeoutMs === undefined ? null : at + opts.timeoutMs,
    }

    return new Promise<T | InteractionAnswer>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      /* 唯一的结账点：答复、超时、中止三条路都从这里走（legacy DialogDesk 把三条归一，是为了让「结了但没告知」写不出来） */
      const settle = (answer: InteractionAnswer): void => {
        if (!this.waiting.delete(id)) return
        if (timer !== undefined) clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', onAbort)
        this.changes.fire({ type: 'resolved', resolved: true, id, interaction, answer })
        /* R-08-3：`toUpstream` 抛错时把 Promise 拒掉，而不是让它永远挂着（工具卡死） */
        try {
          resolve(toUpstream === undefined ? answer : toUpstream(answer))
        } catch (error) {
          reject(error)
        }
      }

      /* 中止与超时都是「没人答」：以 dismiss 兑现，发 resolved，不编一个答复 */
      const onAbort = (): void => {
        settle(DISMISS)
      }

      /*
       * 已经作废的那一次压根不登记：abort 监听器只在 abort **之后**触发，信号若在登记之前
       * 就已中止，监听器永远不会响，这次交互就永远留在等人答的表里 —— 屏幕上是收不掉的带子。
       * 所以先看状态再决定问不问（12 页 §8.1 第 3 点）。
       */
      if (opts?.signal?.aborted === true) {
        try {
          resolve(toUpstream === undefined ? DISMISS : toUpstream(DISMISS))
        } catch (error) {
          reject(error)
        }
        return
      }

      this.waiting.set(id, { interaction, settle })

      if (opts?.timeoutMs !== undefined) {
        timer = setTimeout(() => settle(DISMISS), opts.timeoutMs)
      }
      opts?.signal?.addEventListener('abort', onAbort, { once: true })

      this.changes.fire({ type: 'requested', resolved: false, id, interaction })
    })
  }

  /** 答复。认不出的号如实说没有；答复类型与请求类型不匹配（dismiss 除外）也是错的 */
  answer(interactionId: string, answer: InteractionAnswer): void {
    const waiting = this.waiting.get(interactionId)
    if (waiting === undefined) {
      throw new AppError(EngineErrorCode.interactionExpired, '该请求已失效', { interactionId })
    }
    if (answer.kind !== 'dismiss' && answer.kind !== waiting.interaction.kind) {
      throw new AppError(SystemErrorCode.invalidParams, '答复类型与请求不匹配', {
        interactionId,
        requested: waiting.interaction.kind,
        answered: answer.kind,
      })
    }
    waiting.settle(answer)
  }

  /**
   * 把还在等的全部以 dismiss 兑现（返回兑现了几个）。
   *
   * 上游授权闸门问的那次 select **不带 signal**（wrapper.ts:401），点「取消」不会让它自己作罢；
   * 谁都不结它，那次工具调用就永远停在 await 上，屏幕那条带子也永远停在「等你批」。
   * 已经答过的不在其中（settle 里已出表），重复调用安全。
   */
  cancelAll(): number {
    const entries = [...this.waiting.values()]
    for (const waiting of entries) waiting.settle(DISMISS)
    return entries.length
  }

  /** 当前待答交互，最老的在前（登记顺序就是 Map 的插入顺序） */
  pending(): readonly Interaction[] {
    return [...this.waiting.values()].map((entry) => entry.interaction)
  }

  /** 04 页 §3.12 的旧名，与 pending() 是同一份账 */
  list(): readonly Interaction[] {
    return this.pending()
  }

  pendingCount(): number {
    return this.waiting.size
  }

  /** 会话销毁时用：先把还等的都兑现，再清空订阅，之后 fire 不再通知任何人 */
  dispose(): void {
    this.cancelAll()
    this.changes.dispose()
  }
}

interface Waiting {
  readonly interaction: Interaction
  readonly settle: (answer: InteractionAnswer) => void
}
