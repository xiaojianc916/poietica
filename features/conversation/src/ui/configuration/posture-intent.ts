import type { PermissionPosturePort } from '../agent/permission'
import { createExternalStore } from '../components/primitives/external-store'

/*
 * 批准方式的**跨会话意图**。
 *
 * legacy 把上一趟按下的那一档写成一条客户端偏好（`poietica.permission-posture`），
 * 开机先读回来、再拿它去对齐新建的会话 —— 所以「选过一次完全访问」在重开软件之后
 * 仍然是完全访问。新架构里这条记忆的正主是 `uiState` 的
 * `'conversation.permissionPosture'`（与 `conversation.drafts` 同一条理由：渲染层
 * 记得住的东西住在渲染层）。
 *
 * 形状只有一格：**内存里那一份 + 异步落盘**。`read()` 必须同步答得出来 ——
 * 两台 store（锚会话与单条对话）在 agent 答复落地的那一刻就要拿它判「要不要补发
 * 一次对齐」，等一次往返就等于那一帧先画错再改回来。
 */

export interface PostureIntent extends PermissionPosturePort {
  /** 订阅意图变化：入口页那一格的初始值跟着它走（外部 store 形制）。 */
  readonly subscribe: (listener: () => void) => () => void
  /** 开机读一次盘上的那一份。失败按「没有意图」处置，只上报、不抛。 */
  load(): Promise<void>
}

export interface PostureIntentOptions {
  /** 读盘上那一份（preferences 契约的 `uiState.get`）。 */
  readonly read: () => Promise<unknown>
  /** 写回去（preferences 契约的 `uiState.set`，去抖落盘由 Host 负责）。 */
  readonly write: (value: string) => Promise<void>
  /** 读写失败只影响「下次开窗记不记得住」，不该把界面拖崩：交给调用方上报。 */
  readonly report?: ((cause: unknown) => void) | undefined
}

export function createPostureIntent({ read, report, write }: PostureIntentOptions): PostureIntent {
  let held: string | undefined
  const store = createExternalStore<string | undefined>({ read: () => held })

  return {
    read: () => held,
    subscribe: store.subscribe,
    /*
     * 先改内存再发出去（与 `default_model` 的落盘同一条顺序）：失手时盘上那份仍是
     * 用户上一次真的按下的那一颗，而屏幕上这一趟照旧按人刚点的走。
     */
    write: (value) => {
      if (value === held) {
        return
      }

      held = value
      store.notify()
      void write(value).catch((cause: unknown) => {
        report?.(cause)
      })
    },
    async load() {
      try {
        const value = await read()

        if (typeof value === 'string' && value !== '' && value !== held) {
          held = value
          store.notify()
        }
      } catch (cause: unknown) {
        report?.(cause)
      }
    },
  }
}
