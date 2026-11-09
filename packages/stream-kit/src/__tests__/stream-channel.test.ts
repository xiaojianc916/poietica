import { describe, expect, test } from 'bun:test'
import type { Clock, Disposable } from '@poietica/foundation'
import { StreamChannel, type StreamSink } from '../index'

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock = {
    now: () => now,
    setTimeout(fn: () => void, ms: number): Disposable {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return { dispose: () => void timers.delete(id) }
    },
    clearTimeout(handle: Disposable): void {
      void handle
    },
    setInterval(): Disposable {
      return { dispose: () => undefined }
    },
    clearInterval(handle: Disposable): void {
      void handle
    },
    advance(ms: number): void {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.fn()
      }
    },
  }
  return clock as Clock & { advance(ms: number): void }
}

function sinkOf<T>(): StreamSink<T> & {
  readonly batches: { epoch: number; seq: number; items: T[] }[]
  resets: number[]
} {
  const batches: { epoch: number; seq: number; items: T[] }[] = []
  const resets: number[] = []
  return {
    batches,
    resets,
    batch: (p) => void batches.push({ epoch: p.epoch, seq: p.seq, items: [...p.items] }),
    reset: (p) => void resets.push(p.epoch),
  }
}

describe('StreamChannel', () => {
  test('合批、编号与位置', () => {
    const clock = manualClock()
    const sink = sinkOf<number>()
    let epoch = 10
    const channel = new StreamChannel(epoch, () => ++epoch, clock, { sink, batchWindowMs: 16 })
    channel.push([1, 2])
    clock.advance(16)
    channel.push([3])
    clock.advance(16)
    expect(sink.batches).toEqual([
      { epoch: 10, seq: 1, items: [1, 2] },
      { epoch: 10, seq: 2, items: [3] },
    ])
    expect(channel.position()).toEqual({ epoch: 10, seq: 2 })
  })

  test('catchUp 在环形缓冲内补齐，超出返回 complete:false', () => {
    const clock = manualClock()
    const sink = sinkOf<number>()
    const channel = new StreamChannel(1, () => 2, clock, { sink, ringCapacity: 2 })
    channel.push([1])
    clock.advance(16)
    channel.push([2])
    clock.advance(16)
    channel.push([3])
    clock.advance(16)
    expect(channel.catchUp(1, 0).complete).toBe(false)
    expect(channel.catchUp(1, 1).batches.map((b) => b.seq)).toEqual([2, 3])
    expect(channel.catchUp(9, 0).complete).toBe(false)
  })

  test('reset 换 epoch 并清空 seq；dropHistory 不换 epoch', () => {
    const clock = manualClock()
    const sink = sinkOf<number>()
    let epoch = 1
    const channel = new StreamChannel(epoch, () => ++epoch, clock, { sink })
    channel.push([1])
    clock.advance(16)
    channel.reset()
    expect(sink.resets).toEqual([2])
    expect(channel.position()).toEqual({ epoch: 2, seq: 0 })
    channel.push([2])
    clock.advance(16)
    channel.dropHistory()
    expect(channel.position()).toEqual({ epoch: 2, seq: 1 })
    expect(channel.catchUp(2, 0).complete).toBe(false)
  })

  test('coalesce 只接收本批并保留顺序', () => {
    const clock = manualClock()
    const sink = sinkOf<number>()
    const channel = new StreamChannel(1, () => 2, clock, {
      sink,
      coalesce: (items) => (items.length > 1 ? [items.reduce((a, b) => a + b, 0)] : items),
    })
    channel.push([1, 2, 3])
    clock.advance(16)
    expect(sink.batches[0]?.items).toEqual([6])
  })
})
