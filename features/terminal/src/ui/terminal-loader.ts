import { INITIAL_TERMINAL_UI, type TerminalUiState } from './terminal-model'
import type { TerminalSession } from './terminal-sessions'
import type { TerminalRuntime, TerminalRuntimeDeps } from './terminal-store'

/* 终端运行时的按需加载壳（P-06）。xterm 连同两个插件约 420KB，以前静态带进入口闭包，每次启动都要解析，哪怕不开终端。现在只在三种
 * 时候加载：用户新建 / 切出终端、或重载恢复时 Host 里确实还有活着的终端。加载之前到达的输出 / 退出通知直接丢弃，恢复时由 replay 补齐。
 *
 * 标签条与面板读的是**这一层**的 snapshot / subscribe，而不是运行时的 store：右坞的标签条要在 xterm 到之前就画出新开的那一格
 * （否则点了「终端」要干等一个分块才有反应），所以加载前的新建先记成排队的标签，加载完用同一个 id 交给运行时建 —— 标签不换人。 */

type TerminalStoreModule = typeof import('./terminal-store')

export interface LazyTerminalDeps extends TerminalRuntimeDeps {
  readonly loadModule?: () => Promise<TerminalStoreModule>
}

export interface LazyTerminalRuntime {
  current(): TerminalRuntime | undefined
  load(): Promise<TerminalRuntime>
  /** 加载前是排队等建的那几格（info 为 null），加载后就是运行时 store 的状态。引用在状态不变时保持不变。 */
  snapshot(): TerminalUiState
  subscribe(listener: () => void): () => void
  /** 加载前恒为 undefined：画面要等 xterm */
  session(id: string): TerminalSession | undefined
  /** 含加载前排队的那几格 */
  count(): number
  writeToHost(terminalId: string, data: string, offset: number): void
  markHostExited(terminalId: string, exitCode: number | null): void
  /** 已加载时同步建（与旧行为一致），否则先排队上标签、加载完再建 */
  create(): void
  select(id: string): void
  close(id: string): void
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

  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  /* 加载前的新建：只有 id，没有画面。queuedState 跟着 queued 一起换，useSyncExternalStore 拿到的引用才稳。 */
  let queuedSeq = 0
  let queued: readonly string[] = []
  let queuedActive: string | null = null
  let queuedState: TerminalUiState = INITIAL_TERMINAL_UI
  const setQueued = (next: readonly string[], active: string | null): void => {
    queued = next
    queuedActive = active !== null && next.includes(active) ? active : (next.at(-1) ?? null)
    queuedState =
      next.length === 0
        ? INITIAL_TERMINAL_UI
        : { terminals: next.map((id) => ({ id, info: null })), activeId: queuedActive }
    notify()
  }

  const load = (): Promise<TerminalRuntime> => {
    pending ??= loadModule().then(
      (module) => {
        const created = module.createTerminalRuntime(deps)
        /* 加载途中功能已被拆掉：建出来就立刻收尾，不留 PTY 与定时器。 */
        if (disposed) {
          created.dispose()
          runtime = created
          return created
        }
        /* 排队的那几格按原 id 建出来，选中哪一格也照旧；之后的变化都从运行时的 store 转过来。 */
        const waiting = queued
        const active = queuedActive
        queued = []
        queuedActive = null
        queuedState = INITIAL_TERMINAL_UI
        for (const id of waiting) created.create(id)
        if (active !== null && waiting.length > 0) created.select(active)
        created.store.subscribe(notify)
        runtime = created
        notify()
        return created
      },
      (cause: unknown) => {
        pending = undefined
        throw cause
      },
    )
    return pending
  }

  const snapshot = (): TerminalUiState => runtime?.store.getState() ?? queuedState

  return {
    current: () => runtime,
    load,
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    session: (id) => runtime?.session(id),
    count: () => snapshot().terminals.length,
    writeToHost(terminalId, data, offset) {
      runtime?.writeToHost(terminalId, data, offset)
    },
    markHostExited(terminalId, exitCode) {
      runtime?.markHostExited(terminalId, exitCode)
    },
    create() {
      if (disposed) return
      if (runtime !== undefined) {
        runtime.create()
        return
      }
      const id = `new-${++queuedSeq}`
      setQueued([...queued, id], id)
      void load().catch((cause: unknown) => {
        /* 排队的标签不会再有画面：撤下来，下一次新建再重新加载。连按几次新建只报一次 —— 第一个续体已经把队清空了。 */
        if (queued.length === 0) return
        setQueued([], null)
        d.onError(cause, '终端没能加载')
      })
    },
    select(id) {
      if (runtime !== undefined) {
        runtime.select(id)
        return
      }
      if (queued.includes(id)) setQueued(queued, id)
    },
    close(id) {
      if (runtime !== undefined) {
        runtime.close(id)
        return
      }
      /* 还没建出来的那一格：撤掉就是关掉，没有 PTY 要收。 */
      if (queued.includes(id)) {
        setQueued(
          queued.filter((queuedId) => queuedId !== id),
          queuedActive === id ? null : queuedActive,
        )
      }
    },
    closeActive() {
      if (runtime !== undefined) {
        runtime.closeActive()
        return
      }
      if (queuedActive !== null) {
        setQueued(
          queued.filter((queuedId) => queuedId !== queuedActive),
          null,
        )
      }
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
      listeners.clear()
      runtime?.dispose()
    },
  }
}
