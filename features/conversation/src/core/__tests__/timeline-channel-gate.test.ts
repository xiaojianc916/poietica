import { describe, expect, test } from 'bun:test'
import { fakeClock } from '@poietica/test-kit'
import type { TranscriptOperation } from '@poietica/transcript'
import { BATCH_WINDOW_MS, RING_MAX_CHARS, TimelineChannel, TOOL_UPDATE_INTERVAL_MS } from '../timeline-channel'

/*
 * P-05：通道把「可以合并的」合并掉、把运行中工具的中间结果节流，并给环形缓存加字符预算。
 *
 * 旧代码原样转发：K1、K3、K4、K7 在旧代码上失败（K4 旧代码多发一份 partial，本身不算错，
 * 但能证明终态会作废压着的中间结果）；K2、K5、K6、K8 是正确性护栏，旧代码上也过。
 */
describe('P-05 通道压缩与节流', () => {
  type Batch = { epoch: number; seq: number; ops: readonly TranscriptOperation[] }
  const TURN = 't1'
  const STEP = 't1:s0'
  const append = (offset: number, text: string): TranscriptOperation => ({
    op: 'append',
    target: { type: 'frame', turnId: TURN, stepId: STEP, frameId: 'text' },
    offset,
    text,
  })
  const tool = (frameId: string, state: 'running' | 'done', output: string): TranscriptOperation =>
    ({
      op: 'frame.upsert',
      turnId: TURN,
      stepId: STEP,
      frame: { kind: 'tool', frameId, toolCallId: frameId, name: 'bash', state, output },
    }) as TranscriptOperation
  const outputOf = (op: TranscriptOperation | undefined): unknown =>
    op?.op === 'frame.upsert' && op.frame.kind === 'tool' ? op.frame.output : undefined
  const toolOps = (batches: readonly Batch[], frameId: string) =>
    batches.flatMap((batch) => batch.ops).filter((op) => op.op === 'frame.upsert' && op.frame.frameId === frameId)

  function open() {
    const clock = fakeClock()
    const batches: Batch[] = []
    const channel = new TimelineChannel(1, () => 2, clock, { ops: (p) => batches.push(p), reset: () => undefined })
    return { clock, batches, channel }
  }

  test('K1 一个窗口里 30 个 token：批内只剩 1 条 append', () => {
    const { clock, batches, channel } = open()
    for (let at = 0; at < 30; at += 1) channel.push([append(at, 'x')])
    clock.advance(BATCH_WINDOW_MS)
    expect(batches.length).toBe(1)
    expect(batches[0]?.ops).toEqual([append(0, 'x'.repeat(30))])
    channel.dispose()
  })

  test('K2 工具第一次出现立刻放行（不等节流点）', () => {
    const { clock, batches, channel } = open()
    channel.push([tool('A', 'running', '')])
    clock.advance(BATCH_WINDOW_MS)
    expect(toolOps(batches, 'A').length).toBe(1)
    channel.dispose()
  })

  test('K3 1 秒里 200 份 50KB 中间结果：最多发 12 份，最后发出的是最新一份', () => {
    const { clock, batches, channel } = open()
    channel.push([tool('A', 'running', '')])
    let last = ''
    for (let at = 1; at <= 200; at += 1) {
      clock.advance(5)
      last = `${String(at)}:${'o'.repeat(50 * 1024)}`
      channel.push([tool('A', 'running', last)])
    }
    clock.advance(TOOL_UPDATE_INTERVAL_MS)
    const sent = toolOps(batches, 'A')
    expect(sent.length).toBeLessThanOrEqual(1 + 1000 / TOOL_UPDATE_INTERVAL_MS + 1)
    expect(outputOf(sent.at(-1))).toBe(last)
    const chars = batches.reduce((sum, batch) => sum + JSON.stringify(batch).length, 0)
    expect(chars).toBeLessThan(600_000)
    channel.dispose()
  })

  test('K4 终态到达时作废压着的中间结果：完成之后不会再冒出一份「运行中」', () => {
    const { clock, batches, channel } = open()
    channel.push([tool('A', 'running', '')])
    clock.advance(BATCH_WINDOW_MS)
    channel.push([tool('A', 'running', 'partial')])
    channel.push([tool('A', 'done', 'final')])
    clock.advance(TOOL_UPDATE_INTERVAL_MS * 3)
    const sent = toolOps(batches, 'A')
    expect(sent.map(outputOf)).toEqual(['', 'final'])
    channel.dispose()
  })

  test('K5 position() / catchUp() 之前先放出压着的中间结果', () => {
    const { clock, channel } = open()
    channel.push([tool('A', 'running', '')])
    clock.advance(BATCH_WINDOW_MS)
    channel.push([tool('A', 'running', 'partial')])
    const at = channel.position()
    const caught = channel.catchUp(at.epoch, 0)
    expect(caught.complete).toBe(true)
    expect(outputOf(caught.batches.at(-1)?.ops.at(-1))).toBe('partial')
    channel.dispose()
  })

  test('K6 reset 丢掉压着的中间结果：新 epoch 之后不会再发', () => {
    const { clock, batches, channel } = open()
    channel.push([tool('A', 'running', '')])
    clock.advance(BATCH_WINDOW_MS)
    channel.push([tool('A', 'running', 'partial')])
    channel.reset()
    clock.advance(TOOL_UPDATE_INTERVAL_MS * 5)
    expect(batches.length).toBe(1)
    channel.dispose()
  })

  test('K7 环形缓存按字符预算裁旧：300 批 × 100K 字符之后，从头补发判为不完整', () => {
    const { channel } = open()
    for (let at = 0; at < 300; at += 1) {
      channel.push([tool(`T${String(at)}`, 'done', 'z'.repeat(100_000))])
      channel.flush()
    }
    expect(channel.catchUp(1, 0).complete).toBe(false)
    const kept = Math.floor(RING_MAX_CHARS / 100_000) - 1
    expect(channel.catchUp(1, 300 - kept).complete).toBe(true)
    channel.dispose()
  })

  test('K8 items.remove 之前先放出压着的：它们的先后不能互换', () => {
    const { clock, batches, channel } = open()
    channel.push([tool('A', 'running', '')])
    clock.advance(BATCH_WINDOW_MS)
    const remove = { op: 'items.remove', ids: [TURN] } as TranscriptOperation
    channel.push([tool('A', 'running', 'partial'), remove])
    clock.advance(BATCH_WINDOW_MS)
    expect(batches.at(-1)?.ops.map((op) => op.op)).toEqual(['frame.upsert', 'items.remove'])
    channel.dispose()
  })
})
