import { describe, expect, test } from 'bun:test'
import { createDeriver } from './derive'
import type { DeriveRequest } from './derive-contract'

class WorkerFixture extends EventTarget {
  readonly sent: DeriveRequest[] = []
  stopped = 0
  failSend = false
  postMessage(message: DeriveRequest): void {
    if (this.failSend) {
      throw new Error('send failed')
    }
    this.sent.push(message)
  }
  terminate(): void {
    this.stopped += 1
  }
  asWorker(): Worker {
    return this as unknown as Worker
  }
}

describe('review worker lifetime', () => {
  test('dispose rejects pending and subsequent work and terminates once', async () => {
    const worker = new WorkerFixture()
    const deriver = createDeriver(worker.asWorker())
    const pending = deriver.derive('patch', true)
    deriver.dispose()
    deriver.dispose()
    await expect(pending).rejects.toThrow('disposed')
    await expect(deriver.derive('patch', true)).rejects.toThrow('disposed')
    expect(worker.stopped).toBe(1)
    expect(worker.sent).toHaveLength(1)
  })
  for (const type of ['error', 'messageerror']) {
    test(`${type} closes the owner and settles every pending request`, async () => {
      const worker = new WorkerFixture()
      const deriver = createDeriver(worker.asWorker())
      const pending = deriver.derive('patch', true)
      worker.dispatchEvent(new Event(type))
      await expect(pending).rejects.toThrow()
      await expect(deriver.derive('patch', true)).rejects.toThrow()
      expect(worker.stopped).toBe(1)
    })
  }
  test('synchronous send failures settle the individual request', async () => {
    const worker = new WorkerFixture()
    worker.failSend = true
    const deriver = createDeriver(worker.asWorker())
    await expect(deriver.derive('patch', true)).rejects.toThrow('send failed')
    deriver.dispose()
  })
  test('replies settle only the matching request', async () => {
    const worker = new WorkerFixture()
    const deriver = createDeriver(worker.asWorker())
    const pending = deriver.derive('patch', true)
    const id = worker.sent[0]?.id
    expect(id).toBeDefined()
    worker.dispatchEvent(new MessageEvent('message', { data: { id, ok: true, files: [] } }))
    await expect(pending).resolves.toEqual([])
    deriver.dispose()
  })
})
