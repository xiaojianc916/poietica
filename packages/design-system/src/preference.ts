import { createExternalStore } from './external-store'

/*
 * 客户端偏好：跨会话保留、进程内唯一、第一帧就必须有答案的那类用户状态。
 *
 * 只有一条管线。侧栏宽度、收起了哪些工作区、当前工作目录 —— 三份状态、三个键，
 * 但「读一次、跨窗口跟随、写回去、读写失败怎么办」是同一件事，不该有三种答案。
 *
 * 用 Web Storage 而不是异步的设置管线：这些值决定第一帧画什么，异步管线在第一帧
 * 读不到值，于是每次开窗都要先画错一帧再改回来。storage 事件让同一个应用的另一个
 * 窗口跟着变 —— 那是平台给的一致性，自己发消息去同步反而会漏。
 *
 * 编解码不在这里：形状是各自领域的事，由调用方给。失败也由调用方上报 ——
 * foundations 层不认识日志管线，把失败藏成默默吞掉才是真正的耦合。
 */

/** 读写失败时交给调用方的事实。 */
export interface PreferenceFailure {
  readonly key: string
  readonly stage: 'read' | 'write'
  readonly cause: unknown
}

export interface PreferenceSource<T> {
  readonly key: string
  /** 没存过、存坏了、或者根本没有 Web Storage 时的答案。 */
  readonly fallback: T
  readonly decode: (raw: string) => T
  /** 交回 null 表示删除这个键，而不是写一个内容为 null 的字符串。 */
  readonly encode: (value: T) => string | null
  readonly onFailure: (failure: PreferenceFailure) => void
}

export interface Preference<T> {
  /** 当前值。纯读，可以直接交给 useSyncExternalStore。 */
  readonly read: () => T
  /** 没有 Web Storage 的宿主里的答案，也就是那一路的服务端快照。 */
  readonly readFallback: () => T
  readonly subscribe: (listen: () => void) => () => void
  /** 值与当前相同时什么都不做：既不写盘，也不通知。 */
  readonly write: (value: T) => void
}

export function createPreference<T>(source: PreferenceSource<T>): Preference<T> {
  const { key, fallback, decode, encode, onFailure } = source

  /* 存坏了不该让界面打不开：回落到默认值，但不吞 —— 交给调用方的上报通道。 */
  function load(): T {
    try {
      const raw = globalThis.localStorage?.getItem(key)

      return raw === null || raw === undefined ? fallback : decode(raw)
    } catch (cause) {
      onFailure({ key, stage: 'read', cause })

      return fallback
    }
  }

  /* 另一个窗口改了同一份偏好。值由那一侧写好了，这里只重读。 */
  function reread(event: StorageEvent): void {
    if (event.key !== null && event.key !== key) {
      return
    }

    value = load()
    store.notify()
  }

  let value = load()

  const store = createExternalStore<T>({
    read: () => value,
    activate: () => {
      globalThis.addEventListener?.('storage', reread)

      return () => {
        globalThis.removeEventListener?.('storage', reread)
      }
    },
  })

  return {
    read: store.read,
    readFallback: () => fallback,
    subscribe: store.subscribe,
    write: (next: T): void => {
      if (Object.is(next, value)) {
        return
      }

      value = next

      try {
        const encoded = encode(next)

        if (encoded === null) {
          globalThis.localStorage?.removeItem(key)
        } else {
          globalThis.localStorage?.setItem(key, encoded)
        }
      } catch (cause) {
        onFailure({ key, stage: 'write', cause })
      }

      store.notify()
    },
  }
}
