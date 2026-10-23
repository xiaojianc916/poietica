import type { SetupUiStateKey } from '../contract'
import type { UiStateSlot, UiStateSlotSpec } from '../ui-api'

/** 槽只需要 uiState 的一读一写（preferences 契约的 `uiState.get` / `uiState.set`）。 */
export interface UiStateIo {
  readonly get: (key: SetupUiStateKey) => Promise<unknown>
  readonly set: (key: SetupUiStateKey, value: unknown) => Promise<void>
}

/*
 * 以前每个 setup 阶段的键各写一遍「读 → restore → 置标志 → 订阅里看标志再写」：布局和路由各一个 restored 布尔，
 * 草稿一套 loadDraftsOnce / loadDrafts / draftPin 闸门，批准方式干脆排在 onCoreReady 里读。规则散在四处，
 * 新加一个键就要再抄一遍、再踩一次「恢复前把默认值写回盘上」。现在规则只有这一份（见 UiStateSlotSpec 的说明）。
 */
export function openUiStateSlot<T>(io: UiStateIo, spec: UiStateSlotSpec<T>): UiStateSlot {
  let restored = false
  /** restore() 正在跑：它引起的变更就是盘上的值，不写回 */
  let restoring = false
  /** 恢复完成之前发生过变更：完成后补写一次（恢复前敲的字、点的开关不丢） */
  let pending = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const write = (): void => {
    if (disposed) return
    if (!restored) {
      pending = true
      return
    }
    void io.set(spec.key, spec.snapshot()).catch((cause: unknown) => {
      spec.report?.(cause, 'write')
    })
  }
  const request = (): void => {
    if (restoring) return
    if (spec.debounceMs === undefined) {
      write()
      return
    }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      write()
    }, spec.debounceMs)
  }
  const settle = (outcome: 'restored' | 'failed'): void => {
    if (outcome === 'restored' || spec.readFailure === 'release') restored = true
    spec.onSettled?.(outcome)
    if (restored && pending) {
      pending = false
      write()
    }
  }
  const apply = (stored: unknown): void => {
    const value = spec.parse(stored)
    if (value === null) return
    restoring = true
    try {
      spec.restore(value)
    } finally {
      restoring = false
    }
  }
  const readOnce = async (): Promise<void> => {
    let stored: unknown
    try {
      stored = await io.get(spec.key)
    } catch (cause: unknown) {
      if (disposed) return
      spec.report?.(cause, 'read')
      settle('failed')
      return
    }
    if (disposed) return
    apply(stored)
    settle('restored')
  }
  const retry = (): Promise<void> => {
    if (restored || disposed) return Promise.resolve()
    inFlight ??= readOnce().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const unsubscribe = spec.subscribe(request)
  void retry()

  return {
    restored: () => restored,
    retry,
    dispose() {
      disposed = true
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
