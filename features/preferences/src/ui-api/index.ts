import { defineServiceToken } from '@poietica/foundation'
import type { Preferences, PreferencesPatch, SetupUiStateKey } from '../contract'

/** 其它功能读偏好用这个令牌；写偏好一律走契约方法。 */
export interface PreferencesApi {
  current(): Preferences
  subscribe(listener: (p: Preferences) => void): () => void
  update(patch: PreferencesPatch): Promise<void>
  /**
   * 开一个 uiState 槽：**创建时就读**（在功能 setup 里调用，请求先于 core.getStatus 发出、按序应答，落在首帧之前），
   * 读回来交给 `restore`，此后状态一变就把 `snapshot()` 写回。只有契约 `UI_STATE_RESTORE` 里声明为 `setup` 的键能开。
   * 调用方负责在 `ctx.lifecycle.onDispose` 里 `dispose()`。
   */
  uiStateSlot<T>(spec: UiStateSlotSpec<T>): UiStateSlot
}

/**
 * 一格「住在 Host 的界面记忆」的恢复与写回规则，所有 setup 阶段的键共用这一份：
 * - 恢复完成之前不写回：此刻的状态是默认值，写出去就把盘上那份盖掉了；恢复前发生的变更记一笔，恢复完成后补写一次；
 * - `restore` 本身引起的变更不写回（那就是盘上的值）；
 * - 有去抖时，闸门在**真正发写的那一刻**判，而不是变更发生的那一刻。
 */
export interface UiStateSlotSpec<T> {
  readonly key: SetupUiStateKey
  /** 盘上那份 → 能恢复的值；没有存值或形状不对返回 null（按「盘上没有」处置，不调 restore）。 */
  readonly parse: (stored: unknown) => T | null
  readonly restore: (value: T) => void
  /** 写回时的整份值 */
  readonly snapshot: () => unknown
  /** 状态变化的订阅：每次通知都可能触发一次写回 */
  readonly subscribe: (listener: () => void) => () => void
  /**
   * 读失败怎么办：
   * - `release`：当作盘上没有、照常开始写回（布局、路由这类「默认值也能用」的）；
   * - `hold`：保持未恢复、一直不写回，等 `retry()`（草稿：写出去就是拿空状态覆盖盘上的真值）。
   */
  readonly readFailure: 'release' | 'hold'
  /** 写回去抖（毫秒）；不给就同步写 */
  readonly debounceMs?: number
  /** 每一次读结束都调：成功（哪怕盘上是空的）为 restored，读失败为 failed */
  readonly onSettled?: (outcome: 'restored' | 'failed') => void
  /** 读写失败只影响「下次开窗记不记得住」，不抛：交给调用方上报 */
  readonly report?: (cause: unknown, op: 'read' | 'write') => void
}

export interface UiStateSlot {
  /** 写回闸门是否已打开（读成功，或读失败但 readFailure 为 release） */
  restored(): boolean
  /** 还没恢复就再读一次；同一时刻只有一次在读，已恢复时直接返回 */
  retry(): Promise<void>
  dispose(): void
}

export const PreferencesToken = defineServiceToken<PreferencesApi>('preferences', 'Preferences')
