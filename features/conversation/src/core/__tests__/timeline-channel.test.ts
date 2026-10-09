import { describe, expect, test } from 'bun:test'
import { fakeClock } from '@poietica/test-kit'
import type { TranscriptOperation } from '@poietica/transcript'
import { BATCH_WINDOW_MS, RING_CAPACITY, TimelineChannel } from '../timeline-channel'
import { TimelineHub } from '../timeline-hub'

const op = (n: number): TranscriptOperation =>
  ({ op: 'meta.merge', meta: { activity: 'turn' }, marker: n }) as unknown as TranscriptOperation

describe('CV-9 TimelineChannel', () => {
  test('16ms 合批：同一窗口内 3 次 push 只发 1 条通知', () => {
    const clock = fakeClock()
    const batches: { epoch: number; seq: number; ops: readonly TranscriptOperation[] }[] = []
    let epoch = 1
    const channel = new TimelineChannel(1, () => ++epoch, clock, {
      ops: (p) => batches.push(p),
      reset: () => undefined,
    })
    channel.push([op(1)])
    channel.push([op(2)])
    channel.push([op(3)])
    expect(batches.length).toBe(0)
    clock.advance(BATCH_WINDOW_MS)
    expect(batches.length).toBe(1)
    expect(batches[0]!.seq).toBe(1)
    expect(batches[0]!.ops.length).toBe(3)
    channel.dispose()
  })

  test('push 空数组不排批次', () => {
    const clock = fakeClock()
    const batches: unknown[] = []
    const channel = new TimelineChannel(1, () => 2, clock, { ops: (p) => batches.push(p), reset: () => undefined })
    channel.push([])
    clock.advance(BATCH_WINDOW_MS)
    expect(batches.length).toBe(0)
    channel.dispose()
  })

  test('position() 先冲刷，返回当前位置', () => {
    const clock = fakeClock()
    const channel = new TimelineChannel(1, () => 2, clock, { ops: () => undefined, reset: () => undefined })
    channel.push([op(1)])
    expect(channel.position()).toEqual({ epoch: 1, seq: 1 })
    channel.dispose()
  })

  test('catchUp 在缓冲内返回 complete:true，超出返回 complete:false', () => {
    const clock = fakeClock()
    const channel = new TimelineChannel(1, () => 2, clock, { ops: () => undefined, reset: () => undefined })
    channel.push([op(1)])
    channel.flush()
    channel.push([op(2)])
    channel.flush()
    expect(channel.catchUp(1, 1).complete).toBe(true)
    expect(channel.catchUp(1, 1).batches.map((b) => b.seq)).toEqual([2])
    // 缓冲里最早的批次是 1，sinceSeq=0 要求从 1 开始：这是完整的
    expect(channel.catchUp(1, 0).complete).toBe(true)
    // epoch 不同 → 不完整
    expect(channel.catchUp(99, 0).complete).toBe(false)
    channel.dispose()
  })

  test('环形缓冲超过 RING_CAPACITY 后，太旧的 sinceSeq 判为不完整', () => {
    const clock = fakeClock()
    const channel = new TimelineChannel(1, () => 2, clock, { ops: () => undefined, reset: () => undefined })
    for (let i = 0; i < RING_CAPACITY + 5; i++) {
      channel.push([op(i)])
      channel.flush()
    }
    expect(channel.catchUp(1, 0).complete).toBe(false)
    expect(channel.catchUp(1, RING_CAPACITY).complete).toBe(true)
    channel.dispose()
  })

  test('reset 换一个更大的 epoch 并发出 reset 通知', () => {
    const clock = fakeClock()
    const resets: number[] = []
    const channel = new TimelineChannel(1, () => 7, clock, {
      ops: () => undefined,
      reset: (p) => resets.push(p.epoch),
    })
    channel.push([op(1)])
    channel.flush()
    channel.reset()
    expect(resets).toEqual([7])
    expect(channel.position()).toEqual({ epoch: 7, seq: 0 })
    channel.dispose()
  })

  /*
   * R-05 §3.2（M3）：dropHistory 只丢补发历史 —— epoch 与 seq 原地不动、不发 reset，
   * 之后的 catchUp 因为缓存为空而报 complete:false，UI 自然走整读。
   * 旧代码根本没有这个方法。
   */
  test('R-05 M3 dropHistory 丢历史但不换 epoch / 不重置 seq / 不通知 UI', () => {
    const clock = fakeClock()
    const resets: number[] = []
    const channel = new TimelineChannel(1, () => 7, clock, {
      ops: () => undefined,
      reset: (p) => resets.push(p.epoch),
    })
    channel.push([op(1)])
    channel.flush()
    channel.push([op(2)])
    channel.flush()
    channel.push([op(3)])
    channel.flush()

    channel.dropHistory()
    expect(resets).toEqual([])
    expect(channel.position()).toEqual({ epoch: 1, seq: 3 })
    const caught = channel.catchUp(1, 1)
    expect(caught.complete).toBe(false)
    expect(caught.latestSeq).toBe(3)
    expect(caught.batches).toEqual([])
    channel.dispose()
  })
})

describe('TimelineHub', () => {
  test('epoch 是全局递增的，不同通道不重复', () => {
    const clock = fakeClock()
    const hub = new TimelineHub({ clock, emitOps: () => undefined, emitReset: () => undefined, epochBase: 1 })
    const a = hub.position('t1', 'main')
    const b = hub.position('t2', 'main')
    expect(a.epoch).toBe(1)
    expect(b.epoch).toBe(2)
    hub.dispose()
  })

  /*
   * R-04 S1：两个先后启动的进程（两个 hub）各自的**第一个** epoch 不能相等。
   *
   * 旧代码 next = 1，两个进程里第一个被打开的线程都拿到 epoch 1 —— UI 侧「比较 epoch」
   * 这条防线在最常见的重启场景下失效。默认起点必须是随机的。
   */
  test('R-04 S1 两个进程的首个 epoch 不相等（随机起点）', () => {
    const clock = fakeClock()
    const epochs: number[] = []
    for (let i = 0; i < 20; i += 1) {
      const hub = new TimelineHub({ clock, emitOps: () => undefined, emitReset: () => undefined })
      epochs.push(hub.position('t1', 'main').epoch)
      hub.dispose()
    }
    expect(new Set(epochs).size).toBe(epochs.length)
  })

  test('通道不存在时 catchUp 返回 complete:false、latestSeq 0', () => {
    const clock = fakeClock()
    const hub = new TimelineHub({ clock, emitOps: () => undefined, emitReset: () => undefined, epochBase: 1 })
    expect(hub.catchUp('nope', 'main', 1, 0)).toEqual({ batches: [], latestSeq: 0, complete: false })
    hub.dispose()
  })

  test('op 通知带 threadId 与 agentId；16ms 合批', () => {
    const clock = fakeClock()
    const seen: { threadId: string; agentId: string; seq: number; count: number }[] = []
    const hub = new TimelineHub({
      clock,
      emitOps: (p) => seen.push({ threadId: p.threadId, agentId: p.agentId, seq: p.seq, count: p.ops.length }),
      emitReset: () => undefined,
      epochBase: 1,
    })
    hub.push('t1', 'main', [op(1), op(2)])
    clock.advance(BATCH_WINDOW_MS)
    expect(seen).toEqual([{ threadId: 't1', agentId: 'main', seq: 1, count: 2 }])
    hub.dispose()
  })

  test('disposeThread 之后 position 会新建通道（新的 epoch）', () => {
    const clock = fakeClock()
    const hub = new TimelineHub({ clock, emitOps: () => undefined, emitReset: () => undefined, epochBase: 1 })
    const first = hub.position('t1', 'main')
    hub.disposeThread('t1')
    const second = hub.position('t1', 'main')
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(hub.has('t1', 'main')).toBe(true)
    hub.dispose()
  })

  test('resetThread 只动该线程的通道', () => {
    const clock = fakeClock()
    const resets: { threadId: string; epoch: number }[] = []
    const hub = new TimelineHub({
      clock,
      emitOps: () => undefined,
      emitReset: (p) => resets.push({ threadId: p.threadId, epoch: p.epoch }),
      epochBase: 1,
    })
    hub.position('t1', 'main')
    hub.position('t2', 'main')
    hub.resetThread('t1')
    expect(resets.length).toBe(1)
    expect(resets[0]!.threadId).toBe('t1')
    hub.dispose()
  })

  /* R-05 §3.2：hub 的 dropHistory 按线程清补发历史，不动别的线程 */
  test('R-05 dropHistory 只清该线程的缓存', () => {
    const clock = fakeClock()
    const hub = new TimelineHub({ clock, emitOps: () => undefined, emitReset: () => undefined, epochBase: 1 })
    hub.push('t1', 'main', [op(1)])
    const t1 = hub.position('t1', 'main')
    hub.push('t2', 'main', [op(1)])
    const t2 = hub.position('t2', 'main')
    expect(hub.catchUp('t1', 'main', t1.epoch, 0).complete).toBe(true)
    expect(hub.catchUp('t2', 'main', t2.epoch, 0).complete).toBe(true)

    hub.dropHistory('t1')
    expect(hub.catchUp('t1', 'main', t1.epoch, 0).complete).toBe(false)
    expect(hub.catchUp('t2', 'main', t2.epoch, 0).complete).toBe(true)
    hub.dispose()
  })
})
