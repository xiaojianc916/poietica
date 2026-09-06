import { describe, expect, it } from 'bun:test'
import type { Said } from '../interjection-contract'
import { InterjectionOutbox } from '../interjection-outbox'

const said = (text: string): Said => ({ assets: [], configuration: [], skills: [], text })
function deferred<T>() {
  let release: (value: T) => void = () => {
    throw new Error('Deferred not initialized.')
  }
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, resolve: (value: T) => release(value) }
}
function settled(outbox: InterjectionOutbox): Promise<void> {
  const ready = () =>
    outbox.read().inflight === undefined &&
    (outbox.read().queue.length === 0 || outbox.read().paused)
  if (ready()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const off = outbox.subscribe(() => {
      if (ready()) {
        off()
        resolve()
      }
    })
  })
}
const failUnexpectedly = (cause: unknown): void => {
  throw cause
}

describe('InterjectionOutbox ownership', () => {
  it('steers the receipt belonging to this delivery', async () => {
    const receipt = deferred<string | null>()
    const merged: string[] = []
    const outbox = new InterjectionOutbox({
      deliver: () => receipt.promise,
      isBusy: () => true,
      failed: failUnexpectedly,
      merge: async (id) => {
        merged.push(id)
      },
    })
    outbox.say(said('interrupt'))
    expect(outbox.read().inflight?.text).toBe('interrupt')
    receipt.resolve('this-command')
    await settled(outbox)
    expect(merged).toEqual(['this-command'])
    outbox.dispose()
  })
  it('keeps FIFO until both the receipt and steering have settled', async () => {
    const receipt = deferred<string | null>()
    const steering = deferred<void>()
    const entered = deferred<void>()
    const delivered: string[] = []
    const outbox = new InterjectionOutbox({
      deliver: (item) => {
        delivered.push(item.text)
        return item.text === 'first' ? receipt.promise : Promise.resolve('second-id')
      },
      isBusy: () => true,
      failed: failUnexpectedly,
      merge: async () => {
        entered.resolve()
        await steering.promise
      },
    })
    outbox.say(said('first'))
    outbox.say(said('second'))
    expect(delivered).toEqual(['first'])
    receipt.resolve('first-id')
    await entered.promise
    expect(delivered).toEqual(['first'])
    steering.resolve()
    await settled(outbox)
    expect(delivered).toEqual(['first', 'second'])
    outbox.dispose()
  })
  it('releases an idle delivery from its receipt without a view clock', async () => {
    const delivered: string[] = []
    const merged: string[] = []
    const outbox = new InterjectionOutbox({
      deliver: async (item) => {
        delivered.push(item.text)
        return item.id
      },
      isBusy: () => false,
      failed: failUnexpectedly,
      merge: async (id) => {
        merged.push(id)
      },
    })
    outbox.say(said('first'))
    outbox.say(said('second'))
    await settled(outbox)
    expect(delivered).toEqual(['first', 'second'])
    expect(merged).toEqual([])
    outbox.dispose()
  })
  it('retains editing, ordering, removal and the replacement command context', async () => {
    const receipt = deferred<string | null>()
    const delivered: string[] = []
    const prepared: string[] = []
    const outbox = new InterjectionOutbox({
      deliver: async (item, context) => {
        delivered.push(item.text)
        await context.prepare?.()
        return item.text === 'first' ? receipt.promise : item.id
      },
      isBusy: () => false,
      failed: failUnexpectedly,
      merge: async () => undefined,
    })
    outbox.say(said('first'))
    outbox.say(said('edit'))
    outbox.say(said('remove'))
    const edit = outbox.read().queue[0]?.id
    const remove = outbox.read().queue[1]?.id
    if (edit === undefined || remove === undefined) {
      throw new Error('Queue is missing.')
    }
    outbox.arrange([remove, remove, edit])
    outbox.checkout(edit)
    outbox.drop(remove)
    outbox.say(said('edited'), {
      prepare: async () => {
        prepared.push('replacement')
        return true
      },
    })
    receipt.resolve('first-id')
    await settled(outbox)
    expect(delivered).toEqual(['first', 'edited'])
    expect(prepared).toEqual(['replacement'])
    expect(outbox.read().editing).toBeUndefined()
    outbox.dispose()
  })
  it('pauses after an indeterminate delivery and does not replay it', async () => {
    const delivered: string[] = []
    const outbox = new InterjectionOutbox({
      deliver: async (item) => {
        delivered.push(item.text)
        return item.text === 'unknown' ? null : item.id
      },
      isBusy: () => false,
      failed: failUnexpectedly,
      merge: async () => undefined,
    })
    outbox.say(said('unknown'))
    outbox.say(said('waiting'))
    await settled(outbox)
    expect(delivered).toEqual(['unknown'])
    expect(outbox.read().paused).toBe(true)
    const next = outbox.read().queue[0]?.id
    if (next === undefined) {
      throw new Error('Queued command was lost.')
    }
    outbox.urge(next)
    await settled(outbox)
    expect(delivered).toEqual(['unknown', 'waiting'])
    outbox.dispose()
  })
  it('reports delivery rejection and pauses the remaining FIFO', async () => {
    const failures: unknown[] = []
    const cause = new Error('Rejected')
    const outbox = new InterjectionOutbox({
      deliver: async () => {
        throw cause
      },
      isBusy: () => false,
      failed: (failure) => {
        failures.push(failure)
      },
      merge: async () => undefined,
    })
    outbox.say(said('first'))
    outbox.say(said('second'))
    await settled(outbox)
    expect(failures).toEqual([cause])
    expect(outbox.read().queue.map((item) => item.text)).toEqual(['second'])
    outbox.dispose()
  })
  it('does not replay an accepted prompt after steering fails', async () => {
    const delivered: string[] = []
    const failures: unknown[] = []
    const outbox = new InterjectionOutbox({
      deliver: async (item) => {
        delivered.push(item.text)
        return item.id
      },
      isBusy: () => true,
      failed: (cause) => {
        failures.push(cause)
      },
      merge: async () => {
        throw new Error('Steering refused')
      },
    })
    outbox.say(said('first'))
    outbox.say(said('second'))
    await settled(outbox)
    expect(delivered).toEqual(['first', 'second'])
    expect(failures).toHaveLength(2)
    outbox.dispose()
  })
  it('disposal prevents a late receipt from releasing another command', async () => {
    const receipt = deferred<string | null>()
    const delivered: string[] = []
    const outbox = new InterjectionOutbox({
      deliver: (item) => {
        delivered.push(item.text)
        return receipt.promise
      },
      isBusy: () => true,
      failed: failUnexpectedly,
      merge: async () => undefined,
    })
    outbox.say(said('first'))
    outbox.say(said('second'))
    outbox.dispose()
    outbox.dispose()
    receipt.resolve('accepted')
    await receipt.promise
    await Promise.resolve()
    expect(delivered).toEqual(['first'])
    expect(outbox.read().queue).toEqual([])
    expect(() => outbox.say(said('late'))).toThrow('disposed')
  })
})
