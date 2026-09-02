import { parseUnifiedPatch } from '@poietica/review'
import type { DeriveReply, DeriveRequest } from './derive-contract'
import { paint } from './syntax'

const port = self as unknown as {
  addEventListener(kind: 'message', listener: (event: MessageEvent<DeriveRequest>) => void): void
  postMessage(message: DeriveReply): void
}

port.addEventListener('message', (event) => {
  const { id, patch, wordDiff } = event.data
  void (async () => {
    try {
      const files = await paint(parseUnifiedPatch(patch, wordDiff))
      port.postMessage({ files, id, ok: true })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      port.postMessage({
        id,
        ok: false,
        error: { code: 'REVIEW_DERIVE_FAILED', message },
      })
    }
  })()
})
