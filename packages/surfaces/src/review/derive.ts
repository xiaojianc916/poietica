import type { DiffFile, ReviewDerive } from '@poietica/review'

/*
 * worker 客户端：谁创建谁销毁；在飞的请求随销毁与崩溃一并拒绝，交回调用侧
 * 的 catch 去报告。协议正本在 derive.worker.ts。
 */
interface Reply {
  readonly files?: readonly DiffFile[]
  readonly id: number
  readonly trouble?: string
}
interface Waiting {
  readonly reject: (cause: unknown) => void
  readonly resolve: (files: readonly DiffFile[]) => void
}
export interface ReviewDeriver {
  readonly derive: ReviewDerive
  readonly dispose: () => void
}
export function createDeriver(): ReviewDeriver {
  const worker = new Worker(new URL('./derive.worker.ts', import.meta.url), { type: 'module' })
  const waiting = new Map<number, Waiting>()
  let next = 0
  const failAll = (message: string): void => {
    for (const held of waiting.values()) {
      held.reject(new Error(message))
    }
    waiting.clear()
  }
  worker.addEventListener('message', (event: MessageEvent<Reply>) => {
    const held = waiting.get(event.data.id)
    if (held === undefined) {
      return
    }
    waiting.delete(event.data.id)
    if (event.data.files === undefined) {
      held.reject(new Error(event.data.trouble ?? 'deriver 没有带回文件表'))
      return
    }
    held.resolve(event.data.files)
  })
  /* 加载失败或运行时崩溃都不能把在飞的请求挂成永远的 Promise。 */
  worker.addEventListener('error', () => {
    failAll('derive worker 异常退出')
  })
  return {
    derive: (patch, wordDiff) =>
      new Promise<readonly DiffFile[]>((resolve, reject) => {
        const id = next
        next += 1
        waiting.set(id, { reject, resolve })
        worker.postMessage({ id, patch, wordDiff })
      }),
    dispose: () => {
      worker.terminate()
      failAll('deriver 已销毁')
    },
  }
}
