/*
 * worker 分派用的两件纯工具（审查 R-20-2）。单独成文件、不带任何模块级副作用：`process-mode.ts` 顶层要调
 * declareWorkerHostEntry()，测试若 import 它就会把测试进程声明成 omp 的 worker 宿主。
 */

/**
 * omp 的 cli 模块被 import 时会不会自己按 argv 派发（omp 知识 #1）。
 *
 * `process.env.PI_COMPILED` 必须字面写在这里：编译版的 define 只替换这个字面量，写成别的读法在编译版里就读成运行时的空值。
 */
export function ompCliSelfDispatches(
  compiled: boolean = process.env.PI_COMPILED === 'true',
  mainThread: boolean = Bun.isMainThread,
): boolean {
  return compiled || !mainThread
}

/** `holdEarlyMessages` 要的那一点 port 能力（Node / Bun 的 MessagePort 都有） */
export interface EarlyMessagePort {
  on(event: string, listener: (value: unknown) => void): unknown
  off(event: string, listener: (value: unknown) => void): unknown
}

/** 没人来接时多久放手：只为不让缓存一直挂着（不走 `parentPort.on('message')` 的 worker 永远不会来接） */
export const EARLY_MESSAGE_HOLD_MS = 30_000

/**
 * 在 worker 线程入口的**同步前缀**里接住父线程的早到消息（审查 R-20-2）。
 *
 * 第一个经 `port.on('message', l)` 挂上来的监听者（omp 自派发时 installWorkerInbox 挂的那个）先按到达顺序收到
 * 全部缓存，然后我们的缓存监听者摘掉、`on` 换回原样 —— 之后的消息只走它自己的路。`EARLY_MESSAGE_HOLD_MS` 内没人来接
 * 就同样摘掉并清空缓存。返回值只给测试用：立刻放手。
 */
export function holdEarlyMessages(
  port: EarlyMessagePort,
  holdMs: number = EARLY_MESSAGE_HOLD_MS,
): { readonly release: () => void } {
  const queue: unknown[] = []
  const buffer = (value: unknown): void => {
    queue.push(value)
  }
  const original = port.on
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    clearTimeout(timer)
    port.off('message', buffer)
    port.on = original
    queue.length = 0
  }
  port.on = function patched(this: EarlyMessagePort, event: string, listener: (value: unknown) => void): unknown {
    if (event !== 'message' || released) return original.call(this, event, listener)
    /* 先挂上真正的监听者、再摘缓存：中间不留一个「谁都不在」的空档 */
    const result = original.call(this, event, listener)
    const held = queue.splice(0)
    release()
    for (const value of held) listener(value)
    return result
  }
  original.call(port, 'message', buffer)
  const timer = setTimeout(release, holdMs)
  /* 这根计时器不能把 worker 撑着不退 */
  ;(timer as { unref?: () => void }).unref?.()
  return { release }
}
