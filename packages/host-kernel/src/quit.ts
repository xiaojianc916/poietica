import { type DisposableStore, type Logger, withTimeout } from '@poietica/foundation'
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
  addShutdownHook(moduleId: string, fn: () => void | Promise<void>): void
  addDisposables(store: DisposableStore): void
}

export interface QuitDeps {
  readonly logger: Logger
  readonly supervisor: Pick<CoreSupervisor, 'stop'>
  readonly windows: Pick<WindowRegistry, 'destroyAll'>
  /** 默认 app.exit(code)（06 页 §4.9）；测试注入假实现时不必加载 electron */
  readonly exit?: (code: number) => void
}

export function createQuitCoordinator(o: QuitDeps): QuitCoordinator {
  const exit = o.exit ?? ((code: number) => app.exit(code))
  const hooks: Array<{ moduleId: string; fn: () => void | Promise<void> }> = []
  const stores: DisposableStore[] = []
  let running: Promise<void> | undefined
  return {
    get quitting() {
      return running !== undefined
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
        o.logger.info('quitting', { reason })
        for (const h of [...hooks].reverse()) {
          await withTimeout(Promise.resolve().then(h.fn), 5_000, () => new Error('timeout')).catch((e: unknown) =>
            o.logger.warn('onShutdown hook failed', { module: h.moduleId, error: String(e) }),
          )
        }
        for (const s of [...stores].reverse()) {
          try {
            s.dispose()
          } catch (e) {
            o.logger.warn('dispose failed', { error: String(e) })
          }
        }
        await o.supervisor.stop()
        o.windows.destroyAll()
        o.logger.info('bye')
        if (opts?.finalize === undefined) {
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
      })()
      return running
    },
  }
}
