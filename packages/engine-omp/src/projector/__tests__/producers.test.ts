import { describe, expect, test } from 'bun:test'
import { EMPTY_THREAD_STATE, reduceAll, snapshotOf } from '@poietica/agent-model'
import { LiveProjector } from '../live'

/*
 * 事件表要求的三个生产者：
 * 附件条目（attachmentOp）、插话认领（steeredFrame 有生产者）、压缩标记（marker）。
 * 这三条曾经在实现里缺失（只有接口没有生产者），这里逐个钉住。
 */

const projector = (): LiveProjector => new LiveProjector({ now: () => 1_700_000_000_000 })

describe('LiveProjector 的附件条目', () => {
  test('attachmentOp 产出一条 attachment.added，只带内容寻址的地址', () => {
    const p = projector()
    const events = p.attachmentOp({
      attachmentId: 'a1',
      mediaType: 'image/png',
      sha256: 'a'.repeat(64),
    })
    expect(events.length).toBe(1)
    const page = snapshotOf(reduceAll(EMPTY_THREAD_STATE, events))
    expect(page.attachments.length).toBe(1)
    expect(page.attachments[0]?.mediaType).toBe('image/png')
    expect(page.attachments[0]?.source).toEqual({ kind: 'blob', sha256: 'a'.repeat(64) })
  })

  test('附件先落、用户轮引用它：两批事件合起来能查到那张图', () => {
    const p = projector()
    const attachments = p.attachmentOp({
      attachmentId: 'a1',
      mediaType: 'image/png',
      sha256: 'a'.repeat(64),
    })
    const turn = p.userTurn({ text: '看图', attachmentIds: ['a1'] })
    const page = snapshotOf(reduceAll(EMPTY_THREAD_STATE, [...attachments, ...turn]))
    const first = page.items[0]
    expect(first?.kind === 'turn' && first.attachmentIds).toEqual(['a1'])
    expect(page.attachments.some((a) => a.attachmentId === 'a1')).toBe(true)
  })
})

describe('LiveProjector 的压缩标记', () => {
  test('marker 产出标记事件，开门 running、关门 completed 是同一格', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const open = p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'running' } })
    const close = p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'completed' } })
    const page = snapshotOf(reduceAll(EMPTY_THREAD_STATE, [...open, ...close]))
    const markers = page.items.filter((i) => i.kind === 'marker')
    expect(markers.length).toBe(1)
    expect(markers[0]?.kind === 'marker' && markers[0].markerId).toBe('compaction-1')
  })
})

describe('LiveProjector 的插话帧', () => {
  test('steeredFrame 有生产者：开着一轮时自占一段，文字是人话', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    p.textDelta('前半')
    const events = p.steeredFrame('插一句')
    // 收掉正文那一段、开插话这一段，再放这一帧
    expect(events.map((event) => event.type)).toEqual([
      'item.completed',
      'step.completed',
      'step.started',
      'item.started',
      'item.completed',
    ])
    const page = snapshotOf(reduceAll(EMPTY_THREAD_STATE, [...p.textDelta('x'), ...events]))
    const roles = page.items.flatMap((item) =>
      item.kind === 'turn'
        ? item.steps.flatMap((s) => s.frames.flatMap((f) => (f.kind === 'text' ? [f.role] : [])))
        : [],
    )
    expect(roles).toContain('user')
  })
})
