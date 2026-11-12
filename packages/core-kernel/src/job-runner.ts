import type { Clock, Logger } from '@poietica/foundation'
import type { JobRecord, KernelJobsService } from './jobs'

export interface JobHandler {
  readonly kind: string
  handle(payload: unknown, job: JobRecord): void | Promise<void>
}

export interface JobRunnerOptions {
  readonly jobs: KernelJobsService
  readonly handlers: readonly JobHandler[]
  readonly logger: Logger
  readonly clock: Clock
  /** 默认 500ms */
  readonly intervalMs?: number
  /** 每轮认领上限，默认 10 */
  readonly batchSize?: number
  /** 投递租约，默认 60s */
  readonly leaseMs?: number
  /** 失败退避基数，默认 30s */
  readonly retryDelayMs?: number
}

export interface JobRunner {
  start(): void
  stop(): void
  /** 跑一轮并返回认领数；测试与关停前冲刷用 */
  tick(): Promise<number>
}

/** 持久后台任务分发器：至少一次执行，handler 必须幂等。 */
export function createJobRunner(o: JobRunnerOptions): JobRunner {
  const handlers = new Map(o.handlers.map((handler) => [handler.kind, handler]))
  let timer: { dispose(): void } | undefined
  let running = false

  const deliver = async (job: JobRecord): Promise<void> => {
    const handler = handlers.get(job.kind)
    if (handler === undefined) {
      o.jobs.fail(job.id, `没有注册 job handler：${job.kind}`, o.retryDelayMs ?? 30_000)
      return
    }
    try {
      await handler.handle(job.payload, job)
      o.jobs.complete(job.id)
    } catch (error) {
      o.jobs.fail(job.id, error instanceof Error ? error.message : String(error), o.retryDelayMs ?? 30_000)
      o.logger.warn('job handler failed', { kind: job.kind, id: job.id, error: String(error) })
    }
  }

  const tick = async (): Promise<number> => {
    if (running) return 0
    running = true
    try {
      const batch = o.jobs.claim(o.batchSize ?? 10, o.leaseMs ?? 60_000)
      for (const job of batch) await deliver(job)
      return batch.length
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer !== undefined) return
      timer = o.clock.setInterval(() => void tick(), o.intervalMs ?? 500)
    },
    stop() {
      timer?.dispose()
      timer = undefined
    },
    tick,
  }
}
