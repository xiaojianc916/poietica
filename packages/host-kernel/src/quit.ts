import { type DisposableStore, type Logger, systemClock, withTimeout } from '@poietica/foundation'
import { app } from 'electron'
import type { CoreSupervisor } from './core-supervisor'
import type { WindowRegistry } from './windows'

export interface QuitOptions {
  /**
   * 所有清理（钩子、disposables、停止 Core、销毁窗口）完成后，代替 app.exit(0) 执行。
   * 唯一用途：update 模块传入 () => autoUpdater.quitAndInstall(true, true)。
   * finalize 抛错或 10 秒内进程仍未退出 → app.exit(0)。
   */
  readonly finalize?: () => void
}

export interface QuitCoordinator {
  readonly quitting: boolean
  quit(reason: string, opts?: QuitOptions): Promise<void>
  /**
   * 退出途中用户又启动了一次（second-instance）：单实例锁还在本进程手里，新进程只能退出。
   * 记下来，收尾完成后由本进程 relaunch 一个新实例，用户那一下双击就不会「什么都没发生」。
   */
  requestRelaunch(): void
  addShutdownHook(moduleId: string, fn: () => void | Promise<void>): void
  addDisposables(store: DisposableStore): void
}

export interface QuitDeps {
  readonly logger: Logger
  readonly supervisor: Pick<CoreSupervisor, 'stop' | 'reapOrphans'>
  readonly windows: Pick<WindowRegistry, 'hideAll' | 'destroyAll'>
  /** 默认 app.exit(code)；测试注入假实现时不必加载 electron。 */
  readonly exit?: (code: number) => void
  /** 默认 app.relaunch()；同上。 */
  readonly relaunch?: () => void
}

/**
 * 退出分四段，用户感知的「关掉了」与进程收尾解耦：
 * 1. 离场：窗口立刻藏（不毁）—— 用户点完关闭当场就看不见它了；
 * 2. 停 Core —— Core 关停期间仍可能调用 owner='host' 的方法，Host 服务必须还活着（R-08-11）；
 * 3. 收尾：Host 钩子（倒序串行）与「收 omp 后台进程」并发 —— 后者只碰 Core 那个 exe 派发的进程；
 * 4. 销毁窗口 → 退出（必要时 relaunch）。
 * 从前窗口要等 2～4 全部跑完才销毁，用户看到的就是「点了关闭，窗口还挂着好几秒」。
 */
export function createQuitCoordinator(o: QuitDeps): QuitCoordinator {
  const exit = o.exit ?? ((code: number) => app.exit(code))
  const relaunch = o.relaunch ?? (() => app.relaunch())
  const hooks: Array<{ moduleId: string; fn: () => void | Promise<void> }> = []
  const stores: DisposableStore[] = []
  let running: Promise<void> | undefined
  let relaunchRequested = false

  const runHostHooks = async (): Promise<void> => {
    for (const h of [...hooks].reverse()) {
      await withTimeout(Promise.resolve().then(h.fn), 5_000, () => new Error('timeout')).catch((e: unknown) =>
        o.logger.warn('onShutdown hook failed', { module: h.moduleId, error: String(e) }),
      )
    }
  }

  /** 第 1 段：窗口先藏起来，用户点完关闭当场就看不见它了 */
  const hideWindows = (): void => {
    try {
      o.windows.hideAll()
    } catch (e) {
      o.logger.warn('hide windows failed', { error: String(e) })
    }
  }

  /** 第 3 段的收尾：逆序释放各模块的 disposables，一个抛错不挡下一个 */
  const disposeStores = (): void => {
    for (const s of [...stores].reverse()) {
      try {
        s.dispose()
      } catch (e) {
        o.logger.warn('dispose failed', { error: String(e) })
      }
    }
  }

  /**
   * 第 4 段：退出。update 传了 finalize（quitAndInstall 自己会拉起新版本），那一路不再 relaunch；
   * finalize 抛错或 10 秒内进程仍未退出 → 兜底 app.exit(0)。
   */
  const finish = (opts: QuitOptions | undefined): void => {
    if (opts?.finalize === undefined) {
      if (relaunchRequested) relaunch()
      exit(0)
      return
    }
    setTimeout(() => exit(0), 10_000).unref()
    try {
      opts.finalize()
    } catch (e) {
      o.logger.error('quit finalize failed', { error: String(e) })
      exit(0)
    }
  }

  return {
    get quitting() {
      return running !== undefined
    },
    requestRelaunch: () => {
      if (running === undefined) return
      relaunchRequested = true
    },
    addShutdownHook: (moduleId, fn) => {
      hooks.push({ moduleId, fn })
    },
    addDisposables: (store) => {
      stores.push(store)
    },
    quit(reason, opts) {
      if (running !== undefined) return running
      running = (async () => {
        const t0 = systemClock.now()
        o.logger.info('quitting', { reason })
        hideWindows()
        await o.supervisor.stop()
        const coreStoppedMs = systemClock.now() - t0
        await Promise.all([o.supervisor.reapOrphans(), runHostHooks()])
        disposeStores()
        o.windows.destroyAll()
        o.logger.info('bye', { coreStoppedMs, totalMs: systemClock.now() - t0 })
        finish(opts)
      })()
      return running
    },
  }
}
