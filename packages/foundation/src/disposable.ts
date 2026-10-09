export interface Disposable {
  dispose(): void
}

/** 把回调包装成 Disposable；多次 dispose 只执行一次 */
export function toDisposable(fn: () => void): Disposable {
  let done = false
  return {
    dispose() {
      if (done) return
      done = true
      fn()
    },
  }
}

/**
 * 资源集合。dispose 时按添加的逆序释放；某一项抛错时继续释放其余项，最后抛 AggregateError。
 * dispose 之后再 add 的资源会被立即释放（防止“关闭过程中又注册”造成泄漏）。
 */
export class DisposableStore implements Disposable {
  private readonly items: Disposable[] = []
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose()
      return item
    }
    this.items.push(item)
    return item
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const errors: unknown[] = []
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i]!.dispose()
      } catch (e) {
        errors.push(e)
      }
    }
    this.items.length = 0
    if (errors.length > 0) throw new AggregateError(errors, `${errors.length} 个资源释放失败`)
  }
}
