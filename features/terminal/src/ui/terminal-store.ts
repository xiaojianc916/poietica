import type { Logger } from '@poietica/foundation'
import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { TerminalInfo } from '../contract'
import type { TerminalApi } from './api'
import { INITIAL_TERMINAL_UI, type TerminalEntry, type TerminalUiState } from './terminal-model'
import { createTerminalSessions, type TerminalSession } from './terminal-sessions'

/* xterm 的 Terminal 对象不在 store 里 —— 它们在 terminal-sessions.ts 的 Map 中，store 只放 React 要画的字段（形状见 terminal-model.ts）。 */

export interface TerminalRuntimeDeps {
  readonly api: TerminalApi
  readonly logger: Logger
  readonly cwd: () => string | null
  readonly openExternal: (url: string) => void
  readonly onError: (error: unknown, title: string) => void
}

export interface TerminalRuntime {
  readonly store: FeatureStore<TerminalUiState>
  session(id: string): TerminalSession | undefined
  count(): number
  /** offset 是这段输出首码元在累计输出里的位置（R-08-15）：重放回来的那一份会把这些通知裁到不重不漏。 */
  writeToHost(terminalId: string, data: string, offset: number): void
  markHostExited(terminalId: string, exitCode: number | null): void
  /** id 缺省时自己编；加载壳在 xterm 到之前就把标签上了条，这时传它当初给那一格的 id，标签不换人。 */
  create(id?: string): string
  select(id: string): void
  close(id: string): void
  closeActive(): void
  clearActive(): void
  restore(): Promise<void>
  dispose(): void
}

export function createTerminalRuntime(d: TerminalRuntimeDeps): TerminalRuntime {
  const store = createFeatureStore<TerminalUiState>(() => INITIAL_TERMINAL_UI)
  let disposed = false

  /* 重放与实时输出的对齐（R-08-15）。重载时先订阅、后 replay，两段窗口里的输出既可能在 replay 里、也可能只在通知里，光看内容分不清。
   * 服务端给每段输出带上累计位置 offset，这里按「已写进画面的末尾位置」cursor 去重：整段在 cursor 之前就丢掉；只有前半段在之前就裁掉
   * 重叠前缀；起点在 cursor 之后（中间有缺）就照原样写，不做凭空的补白。replay 还没回来的终端只进 pending。 */
  const cursors = new Map<string, number>()
  const pending = new Map<string, Array<{ offset: number; data: string }>>()
  const replaying = new Set<string>()
  /** 还没配上会话的输出最多留这么多码元，超了丢最老的并记一条 warn */
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

  const neighborOf = (id: string): string | null => {
    const { terminals } = store.getState()
    const index = terminals.findIndex((t) => t.id === id)

    if (index < 0) {
      return null
    }

    return terminals[index + 1]?.id ?? terminals[index - 1]?.id ?? null
  }

  /** 恢复出来的标签不该抢已经在用的焦点。 */
  const pickFirstIfIdle = (): void => {
    const { terminals: list, activeId } = store.getState()
    const first = list[0]

    if (activeId === null && first !== undefined) {
      store.setState((s) => ({ ...s, activeId: first.id }))
    }
  }

  /** 先攒输出、再重放、再按 endOffset 放行。返回 false 表示功能已拆掉，整轮恢复该停下。 */
  const adoptOne = async (info: TerminalInfo): Promise<boolean> => {
    replaying.add(info.terminalId)
    const session = sessions.adopt(info)
    let replayEndOffset = 0

    /* 标签先上：回卷还在路上，用户至少已经看得到这一条终端。 */
    push({ id: session.id, info }, false)

    try {
      const replay = await d.api.replay(info.terminalId)

      if (replay.data.length > 0) {
        session.write(replay.data)
      }

      replayEndOffset = replay.endOffset
    } catch (cause) {
      d.logger.warn('终端重放失败', { terminalId: info.terminalId, error: String(cause) })
    } finally {
      replaying.delete(info.terminalId)
    }

    if (disposed) {
      return false
    }

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
      if (replaying.has(terminalId)) {
        bufferOutput(terminalId, { offset, data })
        return
      }

      writeChunk(terminalId, { offset, data })
    },
    markHostExited: (terminalId, exitCode) => {
      sessions.markHostExited(terminalId, exitCode)
    },
    create(id) {
      const session = sessions.create(id)
      push({ id: session.id, info: null }, true)
      return session.id
    },
    select(id) {
      store.setState((s) => ({ ...s, activeId: id }))
    },
    close(id) {
      const next = neighborOf(id)
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
