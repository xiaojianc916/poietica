/*
 * 视图通知的帧闸门（性能审查 P-02）。
 *
 * 转录的事实每 16ms 到一批（Core 的 timeline-channel 合批窗口），每批都同步叫醒
 * useSyncExternalStore —— React 对外部 store 的变化强制走同步车道，于是「来一批就
 * 完整渲染一次」：单批一旦慢于 16ms，IPC 消息就在渲染进程里堆积；窗口最小化时照样
 * 每批渲染、量布局，切回前台再把积压逐条重画一遍。
 *
 * 这里把「告诉视图有变化」改成按帧合并、最新者胜：
 *   - 一帧之内同一个订阅者最多被叫醒一次，读到的是那一刻的最新快照；
 *   - 窗口不可见时浏览器不跑 requestAnimationFrame（Electron 默认 backgroundThrottling），
 *     视图一次都不渲染；重新可见的第一帧用最新状态渲染一次。
 *
 * 只管视图。事实的订阅者（waitForTerminal、运行集合、系统通知）仍走 TranscriptStore
 * 的同步通知 —— 它们不能跟着帧停。组件只通过 useAssistant* 钩子读转录；绕过钩子直接
 * transcripts.subscribe 的订阅不受这道闸门保护。
 */

/** 请求一帧；交回取消函数。 */
export type FrameRequest = (run: () => void) => () => void

/**
 * 默认的帧：requestAnimationFrame。
 *
 * 在**调用时**查全局，而不是模块加载时：测试的 DOM 预加载、或测试里临时替换帧函数，
 * 都可能晚于本模块加载。没有帧的环境退到 16ms 定时器 —— 合并语义不变。
 */
export const animationFrame: FrameRequest = (run) => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    const handle = globalThis.requestAnimationFrame(() => run())
    return () => globalThis.cancelAnimationFrame(handle)
  }
  const handle = setTimeout(run, 16)
  return () => clearTimeout(handle)
}

export interface ViewFrames {
  /** 下一帧叫醒 listener；同一帧内重复调用只算一次。 */
  schedule(listener: () => void): void
  /** 退订时调用：还没等到帧的那一次不再叫。 */
  forget(listener: () => void): void
}

export function createViewFrames(frame: FrameRequest = animationFrame): ViewFrames {
  const dirty = new Set<() => void>()
  let cancel: (() => void) | null = null

  const flush = (): void => {
    cancel = null
    /* 先拷再清：回调里可能再 schedule（那是下一帧的事），也可能退订别人 */
    const due = [...dirty]
    dirty.clear()
    for (const listener of due) {
      listener()
    }
  }

  return {
    schedule(listener) {
      dirty.add(listener)
      cancel ??= frame(flush)
    },
    forget(listener) {
      dirty.delete(listener)
      if (dirty.size === 0 && cancel !== null) {
        cancel()
        cancel = null
      }
    },
  }
}

/** 全应用共用一道闸门：所有转录切片在同一帧里一起渲染，React 把它们合成一次提交。 */
export const VIEW_FRAMES: ViewFrames = createViewFrames()
