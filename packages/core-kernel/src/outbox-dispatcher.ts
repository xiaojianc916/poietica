import type { Clock, Logger } from '@poietica/foundation'
import type { OutboxService } from './outbox'

export interface OutboxHandler {
  readonly topic: string
  handle(payload: unknown): void | Promise<void>
}

export interface OutboxDispatcherOptions {
  readonly outbox: OutboxService
  readonly handlers: readonly OutboxHandler[]
  readonly logger: Logger
  readonly clock: Clock
  /** 默认 250ms */
  readonly intervalMs?: number
  /** 每轮认领上限，默认 20 */
  readonly batchSize?: number
  /** 投递租约，默认 30s */
  readonly leaseMs?: number
  /** 失败退避基数，默认 30s */
  readonly retryDelayMs?: number
}

export interface OutboxDispatcher {
  start(): void
  stop(): void
  /** 跑一轮并返回本轮认领数；测试与「关停前冲刷」用 */
  tick(): Promise<number>
}

/**
 * Outbox 分发器（ADR-011）：至少一次投递；handler 用业务幂等键保证只生效一次。
 * 这里不自己起事务 —— 入队发生在业务事务里，分发只负责认领、调用、完成/退避。
 */
export function createOutboxDispatcher(o: OutboxDispatcherOptions): OutboxDispatcher {
  const handlers = new Map<string, OutboxHandler[]>()
  for (const handler of o.handlers) {
    const held = handlers.get(handler.topic) ?? []
    held.push(handler)
    handlers.set(handler.topic, held)
  }
  let timer: { dispose(): void } | undefined
  let running = false

  const deliver = async (record: { id: number; topic: string; payload: unknown }): Promise<void> => {
    const registered = handlers.get(record.topic)
    if (registered === undefined || registered.length === 0) {
      o.outbox.fail(record.id, `没有注册 outbox handler：${record.topic}`, o.retryDelayMs ?? 30_000)
      return
    }
    try {
      /* 同 topic 的多个消费者按注册顺序串行：每个都得成功，记录才算投递完成；
         注册顺序就是这里唯一的契约，并发会打乱消费序、也拿不到「谁失败了」。 */
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      for (const handler of registered) await handler.handle(record.payload)
      o.outbox.complete(record.id)
    } catch (error) {
      o.outbox.fail(record.id, error instanceof Error ? error.message : String(error), o.retryDelayMs ?? 30_000)
      o.logger.warn('outbox handler failed', { topic: record.topic, id: record.id, error: String(error) })
    }
  }

  const tick = async (): Promise<number> => {
    if (running) return 0
    running = true
    try {
      const batch = o.outbox.claim(o.batchSize ?? 20, o.leaseMs ?? 30_000)
      /* 串行投递：outbox 按入队序生效，逐个完成/退避才保得住同 topic 的写序。 */
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      for (const record of batch) await deliver(record)
      return batch.length
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer !== undefined) return
      timer = o.clock.setInterval(() => void tick(), o.intervalMs ?? 250)
    },
    stop() {
      timer?.dispose()
      timer = undefined
    },
    tick,
  }
}
