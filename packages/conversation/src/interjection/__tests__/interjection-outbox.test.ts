import { describe, expect, it } from 'bun:test'
import type { Said } from '../interjection-contract'
import { InterjectionOutbox } from '../interjection-outbox'

const said = (text: string): Said => ({
  assets: [],
  configuration: [],
  skills: [],
  text,
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('InterjectionOutbox', () => {
  it('submits a busy message and steers it after KAP assigns an id', async () => {
    const delivered: string[] = []
    const merged: string[] = []
    const outbox = new InterjectionOutbox({
      deliver: (item) => delivered.push(item.text),
      isBusy: () => true,
      merge: (promptId) => {
        merged.push(promptId)
        return Promise.resolve()
      },
    })

    outbox.say(said('插话'))

    expect(delivered).toEqual(['插话'])
    expect(outbox.read().queue).toHaveLength(0)
    expect(outbox.read().inflight?.text).toBe('插话')

    outbox.claimed('prompt-2')
    await flush()

    expect(merged).toEqual(['prompt-2'])
    expect(outbox.read().inflight).toBeUndefined()
  })

  it('keeps FIFO while a steer is being assigned', async () => {
    const delivered: string[] = []
    let release = (): void => undefined
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const outbox = new InterjectionOutbox({
      deliver: (item) => delivered.push(item.text),
      isBusy: () => true,
      merge: () => gate,
    })

    outbox.say(said('第一句'))
    outbox.say(said('第二句'))
    outbox.claimed('prompt-1')
    await flush()

    expect(delivered).toEqual(['第一句'])
    expect(outbox.read().queue.map((item) => item.text)).toEqual(['第二句'])

    release()
    await flush()

    expect(delivered).toEqual(['第一句', '第二句'])
  })

  it('does not steer a prompt released while idle', async () => {
    const merged: string[] = []
    const outbox = new InterjectionOutbox({
      deliver: () => undefined,
      isBusy: () => false,
      merge: (promptId) => {
        merged.push(promptId)
        return Promise.resolve()
      },
    })

    outbox.say(said('普通提问'))
    outbox.claimed('prompt-1')
    await flush()

    expect(merged).toEqual([])
  })
})
