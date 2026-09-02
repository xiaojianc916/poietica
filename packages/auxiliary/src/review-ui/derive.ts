import type { DiffFile, ReviewDerive } from '@poietica/auxiliary/review'
import type { DeriveReply, DeriveRequest } from './derive-contract'

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

  worker.addEventListener('message', (event: MessageEvent<DeriveReply>) => {
    const held = waiting.get(event.data.id)
    if (held === undefined) {
      return
    }
    waiting.delete(event.data.id)
    if (!event.data.ok) {
      held.reject(new Error(event.data.error.message))
      return
    }
    held.resolve(event.data.files)
  })

  worker.addEventListener('error', () => failAll('derive worker 异常退出'))

  return {
    derive: (patch, wordDiff) =>
      new Promise<readonly DiffFile[]>((resolve, reject) => {
        const request: DeriveRequest = { id: next, patch, wordDiff }
        next += 1
        waiting.set(request.id, { reject, resolve })
        worker.postMessage(request)
      }),
    dispose: () => {
      worker.terminate()
      failAll('deriver 已销毁')
    },
  }
}
