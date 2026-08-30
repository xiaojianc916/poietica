/*
 * React 之外的数据源，接线只有这一种形状。
 *
 * useSyncExternalStore 要的是 (subscribe, getSnapshot)。真正会被写第二遍的
 * 不是这两个函数，是它们周围那圈样板：一个 listener 集合、首个订阅者到来时
 * 把真实来源接上、末个订阅者离开时断开、以及一次遍历通知。
 *
 * 它住在 foundations，不住在某一包界面里：需要它的是时钟、设备像素、侧栏布局、
 * 工作目录 —— 分属四个不同的层。放进 features 层的任何一包，同层的包就够不着
 * 它，只能各自再抄一遍那圈样板。
 *
 * 所以这里只抽那圈样板，不抽状态本身：值怎么算、什么时候变，仍然归各自那个
 * 模块。read 必须是纯读 —— React 允许在任意时刻拿它去比对上一次的快照，在它
 * 里面（或在 subscribe 里）改写状态，等于让 React 用一个已经过期的值渲染完
 * 之后再被悄悄换掉。
 */

export interface ExternalStore<T> {
  /** 交给 useSyncExternalStore 的第一个参数，引用终生不变。 */
  readonly subscribe: (listen: () => void) => () => void
  /** 交给 useSyncExternalStore 的第二个参数：纯读当前值。 */
  readonly read: () => T
  /** 值已经换好之后叫一声。没有订阅者时是空操作。 */
  readonly notify: () => void
}

export interface ExternalStoreSource<T> {
  readonly read: () => T
  /**
   * 第一个订阅者到来时把真实来源接上，交回断开它的方法。
   *
   * 末个订阅者离开时调用那个方法。没有真实来源要接（值只由本模块自己写）
   * 时不必给，也可以交回 undefined。
   */
  readonly activate?: (notify: () => void) => (() => void) | undefined
}

export function createExternalStore<T>(source: ExternalStoreSource<T>): ExternalStore<T> {
  const listeners = new Set<() => void>()

  let detach: (() => void) | undefined

  const notify = (): void => {
    for (const listen of listeners) {
      listen()
    }
  }

  const subscribe = (listen: () => void): (() => void) => {
    listeners.add(listen)

    if (listeners.size === 1) {
      detach = source.activate?.(notify)
    }

    return () => {
      listeners.delete(listen)

      if (listeners.size === 0) {
        detach?.()
        detach = undefined
      }
    }
  }

  return { subscribe, read: source.read, notify }
}
