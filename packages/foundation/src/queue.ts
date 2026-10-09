/**
 * 串行队列：任务按 run 的调用顺序一个接一个执行。某个任务失败只影响它自己的返回值，不影响后续任务。
 * 用于“同一资源的写操作必须串行”的场景（例如同一线程的 omp 会话操作）。
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private pendingCount = 0

  /** 尚未完成的任务数（含正在执行的） */
  get size(): number {
    return this.pendingCount
  }

  run<T>(task: () => Promise<T> | T): Promise<T> {
    this.pendingCount++
    const result = this.tail.then(task)
    this.tail = result.then(
      () => {
        this.pendingCount--
      },
      () => {
        this.pendingCount--
      },
    )
    return result
  }

  /** 等待当前已入队的全部任务结束（不论成败） */
  async drain(): Promise<void> {
    await this.tail
  }
}

/** 互斥锁：lock() 返回释放函数；同一时刻只有一个持有者。释放函数重复调用无效果 */
export class Mutex {
  private readonly queue = new SerialQueue()

  get locked(): boolean {
    return this.queue.size > 0
  }

  lock(): Promise<() => void> {
    return new Promise((acquired) => {
      void this.queue.run(
        () =>
          new Promise<void>((release) => {
            let released = false
            acquired(() => {
              if (released) return
              released = true
              release()
            })
          }),
      )
    })
  }

  async runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const release = await this.lock()
    try {
      return await task()
    } finally {
      release()
    }
  }
}
