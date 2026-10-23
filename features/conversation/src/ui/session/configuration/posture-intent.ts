import type { PermissionPosturePort } from '../../shared/model/permission'
import { createExternalStore } from '../../shared/primitives/external-store'

/*
 * 记忆的正主是 `uiState` 的 `'conversation.permissionPosture'`：开机先读回来、再拿它去对齐新建的会话。
 * 形状只有一格：**内存里那一份**。`read()` 必须同步答得出来 —— 两台 store 在 agent 答复落地的那一刻就要拿它判「要不要补发一次对齐」。
 * 读盘与写回不在这里：它是 setup 阶段的键（契约 UI_STATE_RESTORE），由 preferences 的 uiState 槽在 setup 里恢复、
 * 订阅着写回（setup/context.ts）。以前 `load()` 排在首次 onCoreReady 里，冷启动这几秒入口页按默认档画、Core 一就绪再跳。
 */

export interface PostureIntent extends PermissionPosturePort {
  /** 订阅意图变化：入口页那一格的初始值跟着它走（外部 store 形制）；uiState 槽也据此写回。 */
  readonly subscribe: (listener: () => void) => () => void
  /** 盘上那一份读回来了。用户在这之前已经按过一档时不采纳 —— 不拿旧值冲掉人刚按下的那一颗。 */
  restore(value: string): void
}

/** 盘上那一份只认非空字符串：空串与别的类型按「没有意图」处置（uiState 槽的 parse）。 */
export function storedPostureOf(stored: unknown): string | null {
  return typeof stored === 'string' && stored !== '' ? stored : null
}

export function createPostureIntent(): PostureIntent {
  let held: string | undefined
  const store = createExternalStore<string | undefined>({ read: () => held })

  const set = (value: string): void => {
    if (value === held) return
    held = value
    store.notify()
  }

  return {
    read: () => held,
    subscribe: store.subscribe,
    /* 只改内存：落盘由订阅着它的 uiState 槽去做，失手时盘上那份仍是用户上一次真的按下的那一颗，而屏幕上照旧按人刚点的走。 */
    write: set,
    restore(value) {
      if (held === undefined) set(value)
    },
  }
}
