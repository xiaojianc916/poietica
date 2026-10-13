import type { TerminalRuntime, TerminalRuntimeDeps } from './terminal-store'

/* 终端运行时的按需加载壳（P-06）。xterm 连同两个插件约 420KB，以前静态带进入口闭包，每次启动都要解析，哪怕不开终端。现在只在三种
 * 时候加载：用户新建 / 切出终端、面板第一次挂载、或重载恢复时 Host 里确实还有活着的终端。加载之前到达的输出 / 退出通知直接丢弃，
 * 恢复时由 replay 补齐。 */

type TerminalStoreModule = typeof import('./terminal-store')

export interface LazyTerminalDeps extends TerminalRuntimeDeps {
  readonly loadModule?: () => Promise<TerminalStoreModule>
}

export interface LazyTerminalRuntime {
  current(): TerminalRuntime | undefined
  load(): Promise<TerminalRuntime>
  count(): number
  writeToHost(terminalId: string, data: string, offset: number): void
  markHostExited(terminalId: string, exitCode: number | null): void
  /** 已加载时同步建（与旧行为一致），否则加载完再建 */
  create(): void
  closeActive(): void
  clearActive(): void
  restore(): Promise<void>
  dispose(): void
}

export function createLazyTerminalRuntime(d: LazyTerminalDeps): LazyTerminalRuntime {
  const { loadModule = () => import('./terminal-store'), ...deps } = d
  let runtime: TerminalRuntime | undefined
  let pending: Promise<TerminalRuntime> | undefined
  let disposed = false

  const load = (): Promise<TerminalRuntime> => {
    pending ??= loadModule().then(
      (module) => {
        const created = module.createTerminalRuntime(deps)
        /* 加载途中功能已被拆掉：建出来就立刻收尾，不留 PTY 与定时器。 */
        if (disposed) created.dispose()
        runtime = created
        return created
      },
      (cause: unknown) => {
        pending = undefined
        throw cause
      },
    )
    return pending
  }

  return {
    current: () => runtime,
    load,
    count: () => runtime?.count() ?? 0,
    writeToHost(terminalId, data, offset) {
      runtime?.writeToHost(terminalId, data, offset)
    },
    markHostExited(terminalId, exitCode) {
      runtime?.markHostExited(terminalId, exitCode)
    },
    create() {
      if (runtime !== undefined) {
        runtime.create()
        return
      }
      void load().then(
        (loaded) => {
          if (!disposed) loaded.create()
        },
        (cause: unknown) => {
          d.onError(cause, '终端没能加载')
        },
      )
    },
    closeActive() {
      runtime?.closeActive()
    },
    clearActive() {
      runtime?.clearActive()
    },
    async restore() {
      if (runtime === undefined) {
        /* 多问一次清单换来「没有终端就不加载 xterm」；真正的恢复会再按最新清单走一遍。 */
        const terminals = await d.api.list()
        if (terminals.length === 0 || disposed) return
      }
      const loaded = await load()
      if (!disposed) await loaded.restore()
    },
    dispose() {
      disposed = true
      runtime?.dispose()
    },
  }
}
