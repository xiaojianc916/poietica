import type { RuntimeProcessState } from './index'

/** Worker 的最小管理面；RuntimeProcess 与测试替身都满足。 */
export interface ManagedRuntime {
  readonly status: { readonly state: RuntimeProcessState; readonly error: string | null }
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
}

export interface RuntimePoolOptions<T extends ManagedRuntime> {
  readonly create: (key: string) => T
  /** 同时最多几个 Worker；超出后 acquire 直接报错，不做无界排队。 */
  readonly maxWorkers: number
}

/**
 * 按工作树键复用 Worker（架构设计 §10 的路由层）。池只负责「谁在跑、起停、失败后重建」；
 * 心跳、退避与 Run 对账仍由 Worker/上层做，避免把进程细节塞进领域模块。
 */
export class RuntimePool<T extends ManagedRuntime> {
  private readonly workers = new Map<string, T>()

  constructor(private readonly o: RuntimePoolOptions<T>) {}

  get size(): number {
    return this.workers.size
  }

  async acquire(key: string): Promise<T> {
    const existing = this.workers.get(key)
    if (existing !== undefined) {
      if (existing.status.state === 'ready') return existing
      await existing.restart()
      return existing
    }
    if (this.workers.size >= this.o.maxWorkers) {
      throw new Error(`Runtime Worker 数量已达上限 ${this.o.maxWorkers}`)
    }
    const worker = this.o.create(key)
    this.workers.set(key, worker)
    try {
      await worker.start()
    } catch (error) {
      this.workers.delete(key)
      await worker.stop()
      throw error
    }
    return worker
  }

  get(key: string): T | undefined {
    return this.workers.get(key)
  }

  async release(key: string): Promise<void> {
    const worker = this.workers.get(key)
    if (worker === undefined) return
    this.workers.delete(key)
    await worker.stop()
  }

  async stopAll(): Promise<void> {
    const all = [...this.workers.values()]
    this.workers.clear()
    await Promise.all(all.map((worker) => worker.stop()))
  }
}
