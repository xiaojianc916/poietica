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
  /**
   * 把 Host 的输出通知分发到各自的常驻画面。offset 是这段输出首码元在终端累计输出里
   * 的位置（R-08-15）：重放回来的那一份会把这些通知裁到不重不漏。
   */
  writeToHost(terminalId: string, data: string, offset: number): void
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
  let disposed = false

  /*
   * 重放与实时输出的对齐（R-08-15）。渲染进程重载时先订阅、后 replay，两段窗口里的
   * 输出既可能在 replay 里、也可能只在通知里，光看内容分不清。服务端给每段输出带上
   * 累计位置 offset，这里按「已经写进画面的末尾位置」cursor 去重：
   *   - 整段落在 cursor 之前 → 已经被 replay 覆盖，丢掉；
   *   - 只有前半段落在之前 → 裁掉重叠的前缀，写剩下的尾巴；
   *   - 起点在 cursor 之后（中间有缺）→ 照原样写，不做凭空的补白。
   * replay 还没回来的终端只进 pending，回来后用它的 endOffset 当 cursor 再放行。
   */
  const cursors = new Map<string, number>()
  const pending = new Map<string, Array<{ offset: number; data: string }>>()
  const replaying = new Set<string>()
  /* 兜底上限：还没配上会话的输出最多留这么多码元，超了就丢最老的并记一条 warn */
  const PENDING_LIMIT = 1024 * 1024
  let pendingSize = 0

  const bufferOutput = (terminalId: string, chunk: { offset: number; data: string }): void => {
    const list = pending.get(terminalId) ?? []
    list.push(chunk)
    pending.set(terminalId, list)
    pendingSize += chunk.data.length

    while (pendingSize > PENDING_LIMIT && list.length > 1) {
      const dropped = list.shift()!
      pendingSize -= dropped.data.length
      d.logger.warn('终端输出积压被丢弃', { terminalId, dropped: dropped.data.length, offset: dropped.offset })
    }
  }

  const writeChunk = (terminalId: string, chunk: { offset: number; data: string }): void => {
    const cursor = cursors.get(terminalId) ?? 0
    const end = chunk.offset + chunk.data.length

    if (end <= cursor) {
      return
    }

    const data = chunk.offset >= cursor ? chunk.data : chunk.data.slice(cursor - chunk.offset)

    cursors.set(terminalId, end)
    sessions.writeToHost(terminalId, data)
  }

  /** replay 落地或会话刚配上之后，把缓存的输出按 cursor 放行 */
  const flushPending = (terminalId: string): void => {
    const list = pending.get(terminalId)

    if (list === undefined) {
      return
    }

    pending.delete(terminalId)

    for (const chunk of list) {
      pendingSize -= chunk.data.length
      writeChunk(terminalId, chunk)
    }
  }

  const forget = (terminalId: string | null): void => {
    if (terminalId === null) {
      return
    }

    const list = pending.get(terminalId)

    if (list !== undefined) {
      pending.delete(terminalId)
      for (const chunk of list) {
        pendingSize -= chunk.data.length
      }
    }

    cursors.delete(terminalId)
    replaying.delete(terminalId)
  }

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

  /** 没有别的活动标签时挑第一条（恢复出来的标签不该抢已经在用的焦点） */
  const pickFirstIfIdle = (): void => {
    const { terminals: list, activeId } = store.getState()
    const first = list[0]

    if (activeId === null && first !== undefined) {
      store.setState((s) => ({ ...s, activeId: first.id }))
    }
  }

  /**
   * 恢复一条 Host 里还活着的终端：先攒输出、再重放、再按 endOffset 把攒下的放行。
   * 返回 false 表示功能已经被拆掉，整轮恢复该停下。
   */
  const adoptOne = async (info: TerminalInfo): Promise<boolean> => {
    /* 订阅早就在 index.tsx 里接上了：从这一刻起的通知先攒着，别和 replay 撞头 */
    replaying.add(info.terminalId)
    const session = sessions.adopt(info)
    let replayEndOffset = 0

    /* 标签先上：画面上的回卷还在路上，用户至少已经看得到这一条终端 */
    push({ id: session.id, info }, false)

    try {
      const replay = await d.api.replay(info.terminalId)

      if (replay.data.length > 0) {
        session.write(replay.data)
      }

      replayEndOffset = replay.endOffset
    } catch (cause) {
      /* 一个终端重放失败不该拖掉其余终端的恢复；攒下的实时输出仍按原样写下去 */
      d.logger.warn('终端重放失败', { terminalId: info.terminalId, error: String(cause) })
    } finally {
      replaying.delete(info.terminalId)
    }

    if (disposed) {
      return false
    }

    /* 等 replay 期间用户可能已经把它关了：那一份缓存已经丢了，别再解冻 */
    if (sessions.get(session.id) !== undefined) {
      cursors.set(info.terminalId, replayEndOffset)
      flushPending(info.terminalId)
    }

    return true
  }

  const restoreTerminals = async (): Promise<void> => {
    if (disposed) {
      return
    }

    const terminals = await d.api.list()

    /* await 之后重新检查前提：等功能清单回来期间功能可能已经被拆掉了 */
    if (disposed) {
      return
    }

    for (const info of terminals) {
      if (sessions.hasHost(info.terminalId)) {
        continue
      }

      if (!(await adoptOne(info))) {
        return
      }
    }

    pickFirstIfIdle()
  }

  const runtime: TerminalRuntime = {
    store,
    session: (id) => sessions.get(id),
    count: () => store.getState().terminals.length,
    writeToHost: (terminalId, data, offset) => {
      /* replay 还没回来：先攒着，等 replay 的 endOffset 当上 cursor 再放行 */
      if (replaying.has(terminalId)) {
        bufferOutput(terminalId, { offset, data })
        return
      }

      writeChunk(terminalId, { offset, data })
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
      forget(sessions.get(id)?.terminalId() ?? null)
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
      await restoreTerminals()
    },
    dispose() {
      disposed = true
      cursors.clear()
      pending.clear()
      replaying.clear()
      pendingSize = 0
      sessions.disposeAll()
    },
  }

  return runtime
}
