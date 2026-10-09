import { InvariantError } from '@poietica/foundation'
import type { DeriveReply, DeriveRequest } from './derive-contract'
import type { ReviewDerive } from './review-store'
import type { DiffFile } from './unified-diff'

interface Waiting {
  readonly reject: (cause: unknown) => void
  readonly resolve: (files: readonly DiffFile[]) => void
}
export interface ReviewDeriver {
  readonly derive: ReviewDerive
  readonly dispose: () => void
}

export function createDeriver(
  worker: Worker = new Worker(new URL('./derive.worker.ts', import.meta.url), { type: 'module' }),
): ReviewDeriver {
  const waiting = new Map<number, Waiting>()
  let next = 0
  let closed: Error | null = null

  function close(cause: Error): void {
    if (closed !== null) {
      return
    }
    closed = cause
    worker.removeEventListener('message', receive)
    worker.removeEventListener('error', failed)
    worker.removeEventListener('messageerror', unreadable)
    worker.terminate()
    for (const held of waiting.values()) {
      held.reject(cause)
    }
    waiting.clear()
  }
  function receive(event: MessageEvent<DeriveReply>): void {
    if (closed !== null) {
      return
    }
    const held = waiting.get(event.data.id)
    if (held === undefined) {
      return
    }
    waiting.delete(event.data.id)
    if (event.data.ok) {
      held.resolve(event.data.files)
    } else {
      /* worker 里抛出来的东西按不变量带回来（那个 worker 只可能因为代码缺陷失败） */
      held.reject(new InvariantError(event.data.error.message))
    }
  }
  function failed(): void {
    close(new InvariantError('Review worker failed.'))
  }
  function unreadable(): void {
    close(new InvariantError('Review worker message could not be decoded.'))
  }
  worker.addEventListener('message', receive)
  worker.addEventListener('error', failed)
  worker.addEventListener('messageerror', unreadable)

  return {
    derive: (patch, wordDiff) => {
      if (closed !== null) {
        return Promise.reject(closed)
      }
      if (!Number.isSafeInteger(next)) {
        close(new InvariantError('Review worker request sequence exhausted.'))
        return Promise.reject(closed)
      }
      return new Promise<readonly DiffFile[]>((resolve, reject) => {
        const request: DeriveRequest = { id: next, patch, wordDiff }
        next += 1
        waiting.set(request.id, { resolve, reject })
        try {
          worker.postMessage(request)
        } catch (cause: unknown) {
          waiting.delete(request.id)
          reject(cause)
        }
      })
    },
    dispose: () => close(new InvariantError('Review deriver is disposed.')),
  }
}
