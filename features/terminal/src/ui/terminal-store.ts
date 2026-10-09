import type { Logger } from '@poietica/foundation'
import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { TerminalInfo } from '../contract'
import type { TerminalApi } from './api'
import { createTerminalSessions, type TerminalSession } from './terminal-sessions'

/*
 * 终端面板的状态：标签清单与当前标签（07 页 §11E 的 store 形状）。
 * xterm 的 Terminal 对象不在 store 里 —— 它们在 terminal-sessions.ts 的 Map 中，
 * store 只放 React 要画的字段（terminalId / title / exited / exitCode）。
 */

export interface TerminalEntry {
  /** 本地稳定键：PTY 开出来之前就要有标签 */
  readonly id: string
  /** null = 还没量到网格、PTY 还没开 */
  readonly info: TerminalInfo | null
}

export interface TerminalUiState {
  readonly terminals: readonly TerminalEntry[]
  readonly activeId: string | null
}

export const INITIAL_TERMINAL_UI: TerminalUiState = { terminals: [], activeId: null }

/** `t12` → 12；形状不对时回 0（标签只拿它做显示） */
export function terminalOrdinal(terminalId: string): number {
  const n = Number.parseInt(terminalId.slice(1), 10)
  return Number.isFinite(n) ? n : 0
}

/** 标签文字：`title • 序号`；已退出换成状态并变灰（07 页 §11E） */
export function terminalTabLabel(entry: TerminalEntry): string {
  if (entry.info === null) {
    return '终端'
  }

  if (entry.info.exited) {
    return entry.info.exitCode === null ? '已退出' : `已退出 (${entry.info.exitCode})`
  }

  return `${entry.info.title} • ${terminalOrdinal(entry.info.terminalId)}`
}

export interface TerminalRuntimeDeps {
  readonly api: TerminalApi
  readonly logger: Logger
  readonly cwd: () => string | null
  /** 链接出口：platform 契约的 shell.openExternal（07 页 §11E 的「链接」一行） */
  readonly openExternal: (url: string) => void
  readonly onError: (error: unknown, title: string) => void
}

export interface TerminalRuntime {
  readonly store: FeatureStore<TerminalUiState>
  session(id: string): TerminalSession | undefined
  count(): number
  /** 把 Host 的输出 / 退出通知分发到各自的常驻画面 */
  writeToHost(terminalId: string, data: string): void
  markHostExited(terminalId: string, exitCode: number | null): void
  create(): string
  select(id: string): void
  close(id: string): void
  closeActive(): void
  clearActive(): void
  /** 渲染进程重载恢复：list + replay（07 页 §11E） */
  restore(): Promise<void>
  dispose(): void
}

export function createTerminalRuntime(d: TerminalRuntimeDeps): TerminalRuntime {
  const store = createFeatureStore<TerminalUiState>(() => INITIAL_TERMINAL_UI)
  const sessions = createTerminalSessions({
    api: d.api,
    logger: d.logger,
    cwd: d.cwd,
    openExternal: d.openExternal,
    onError: d.onError,
    onInfo: (id, info) => {
      store.setState((s) => ({
        ...s,
        terminals: s.terminals.map((t) => (t.id === id ? { ...t, info } : t)),
      }))
    },
  })

  const push = (entry: TerminalEntry, active: boolean): void => {
    store.setState((s) => ({
      terminals: [...s.terminals, entry],
      activeId: active ? entry.id : s.activeId,
    }))
  }

  /* 关掉当前标签后接哪一条：右邻优先，没有就左邻。 */
  const neighborOf = (id: string): string | null => {
    const { terminals } = store.getState()
    const index = terminals.findIndex((t) => t.id === id)

    if (index < 0) {
      return null
    }

    return terminals[index + 1]?.id ?? terminals[index - 1]?.id ?? null
  }

  const runtime: TerminalRuntime = {
    store,
    session: (id) => sessions.get(id),
    count: () => store.getState().terminals.length,
    writeToHost: (terminalId, data) => {
      sessions.writeToHost(terminalId, data)
    },
    markHostExited: (terminalId, exitCode) => {
      sessions.markHostExited(terminalId, exitCode)
    },
    create() {
      const session = sessions.create()
      push({ id: session.id, info: null }, true)
      return session.id
    },
    select(id) {
      store.setState((s) => ({ ...s, activeId: id }))
    },
    close(id) {
      const next = neighborOf(id)
      /* PTY 的关闭与标签的移除是一件事的两个面：先收尾会话，再把标签摘掉。 */
      sessions.dispose(id)
      store.setState((s) => ({
        terminals: s.terminals.filter((t) => t.id !== id),
        activeId: s.activeId === id ? next : s.activeId,
      }))
    },
    closeActive() {
      const { activeId } = store.getState()

      if (activeId !== null) {
        runtime.close(activeId)
      }
    },
    clearActive() {
      const { activeId } = store.getState()

      if (activeId !== null) {
        sessions.get(activeId)?.clear()
      }
    },
    async restore() {
      const terminals = await d.api.list()

      for (const info of terminals) {
        if (sessions.hasHost(info.terminalId)) {
          continue
        }

        const session = sessions.adopt(info)
        const replay = await d.api.replay(info.terminalId)

        if (replay.length > 0) {
          session.write(replay)
        }

        push({ id: session.id, info }, false)
      }

      /* 恢复出来的标签：没有别的活动标签时挑第一条。 */
      const { terminals: list, activeId } = store.getState()
      const first = list[0]

      if (activeId === null && first !== undefined) {
        store.setState((s) => ({ ...s, activeId: first.id }))
      }
    },
    dispose() {
      sessions.disposeAll()
    },
  }

  return runtime
}
