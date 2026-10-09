import type { DraftAttachments } from '../../ui-api'
import type { ComposerStore } from './composer'

/**
 * 草稿附件视图（R-07 §3.4）：conversation 只交出「草稿里有哪些附件」，
 * 引用登记由 attachments 的 UI 调它自己的契约完成 —— conversation 不认识 attachments。
 *
 * 两处时序判据都收在这里：
 * - 恢复前 `ids()` 为 null（空集合不等于「草稿是空的」）；
 * - 只有**集合真的变了**才通知订阅者（打字每一下都在改 store，逐字符唤醒是白费）。
 */
export interface DraftPinView {
  readonly view: DraftAttachments
  /** 草稿 store 变了：集合真的变了才通知 */
  onChange(): void
  /** 草稿从盘上恢复完成：一定通知一次（attachments 等的是「现在可以登记了」） */
  markRestored(): void
  /** 测试用：当前是否已恢复 */
  restored(): boolean
}

export function createDraftPin(composer: ComposerStore): DraftPinView {
  const listeners = new Set<() => void>()
  let restored = false

  const collect = (): string[] =>
    [...new Set(Object.values(composer.snapshot()).flatMap((d) => d.attachments.map((a) => a.id)))].sort()
  const keyOf = (ids: readonly string[]): string => ids.join('\n')
  /** 上次通知过的集合键；从当前集合起算，打字不改集合就不该通知 */
  let lastKey = keyOf(collect())
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    view: {
      ids: () => (restored ? collect() : null),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      drop: (ids) => composer.dropAttachments(ids),
    },
    onChange() {
      const key = keyOf(collect())
      if (key === lastKey) return
      lastKey = key
      emit()
    },
    markRestored() {
      restored = true
      lastKey = keyOf(collect())
      emit()
    },
    restored: () => restored,
  }
}
