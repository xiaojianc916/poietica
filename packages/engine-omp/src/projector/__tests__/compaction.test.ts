import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState, type TranscriptItem } from '@poietica/transcript'
import { LiveProjector } from '../live'

/*
 * 压缩的桥侧（legacy compaction-events.test.ts，12 页 §12.3）。
 *
 * 缘起是一个真实的缺陷：omp 的压缩事件从前掉进 default: break —— 上下文被压缩时屏幕上
 * 什么都不说，人看到的是自己前几句莫名其妙没了。
 *
 * 判据里最重要的一条是「号要稳」：开门与关门共用同一个 markerId。换号会在屏幕上多出
 * 一行，而人读到的会是「上下文被压了两次」这种不存在的历史。
 *
 * 这里钉的是**投影器自己**产出的 marker（LiveProjector.marker），也就是适配器那两个 case
 * 落下来的同一格；legacy 的 token 计数那一档（result.tokensBefore）新接口不收
 * （12 页 §9.1 的事件表里标记只带状态），所以那几条断言在这里表达不了，见汇报。
 */
const T0 = 1_700_000_000_000

function projector(): LiveProjector {
  return new LiveProjector({ now: () => T0 })
}

/** 时间线里的一行压缩标记 */
type CompactionRow = Extract<TranscriptItem, { kind: 'marker' }>

/** 把一串 marker op 落到时间线上，返回压缩标记那几行（类型谓词把联合收窄到 marker） */
function compactionRows(ops: ReturnType<LiveProjector['marker']>[]) {
  const state = applyOps(emptyTimeline(), ops.flat())
  return {
    state,
    rows: state.items.filter((item): item is CompactionRow => item.kind === 'marker' && item.marker === 'compaction'),
  }
}

describe('压缩标记（legacy compaction-events.test.ts）', () => {
  test('开门与关门是同一条标记，不是两条', () => {
    const p = projector()
    const { rows } = compactionRows([
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'running' } }),
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'completed' } }),
    ])
    // 换号就会在屏幕上多出一行；这里钉的是「号认得出是一件事」
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ markerId: 'compaction-1', payload: { state: 'completed' } })
  })

  test('第二次压缩另起一行', () => {
    const p = projector()
    const { rows } = compactionRows([
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'running' } }),
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'completed' } }),
      p.marker({ markerId: 'compaction-2', marker: 'compaction', payload: { state: 'running' } }),
      p.marker({ markerId: 'compaction-2', marker: 'compaction', payload: { state: 'completed' } }),
    ])
    expect(rows.map((row) => row.markerId)).toEqual(['compaction-1', 'compaction-2'])
  })

  test('没成的压缩不能说成完成', () => {
    // 中止：人按了取消，这次没有结果 —— 适配器把 aborted 收成 cancelled
    const aborted = compactionRows([
      projector().marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'running' } }),
      projector().marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'cancelled' } }),
    ])
    expect(aborted.rows[0]).toMatchObject({ payload: { state: 'cancelled' } })
  })

  test('成了就是完成', () => {
    const p = projector()
    const { rows } = compactionRows([
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'running' } }),
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'completed' } }),
    ])
    expect(rows[0]).toMatchObject({ payload: { state: 'completed' } })
  })

  test('出错时把错误文案带上，不静默吞掉', () => {
    const p = projector()
    const { rows } = compactionRows([
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'cancelled', error: 'boom' } }),
    ])
    expect(rows[0]).toMatchObject({ payload: { state: 'cancelled', error: 'boom' } })
  })

  test('标记不绑轮：没有开轮也落得下痕迹', () => {
    const p = projector()
    const state = applyOps(
      emptyTimeline(),
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'completed' } }),
    )
    expect(state.items.filter((item) => item.kind === 'marker')).toHaveLength(1)
  })

  test('适配器：开门与关门共用同一个号，收口时另发一次「整页重取」', async () => {
    const { fakeOmpSession, opsOf } = await import('./fixtures/omp-session')
    const fake = await fakeOmpSession()
    fake.feed({ type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' })
    fake.feed({
      type: 'auto_compaction_end',
      action: 'context-full',
      result: { tokensBefore: 120_000 },
      aborted: false,
    })

    const markers = opsOf(fake.events).filter((op) => op.op === 'marker.upsert')
    expect(markers).toHaveLength(2)
    // 换号就会在屏幕上多出一行：两次事件必须落在同一个 markerId 上
    const ids = markers.map((op) => (op.item as { markerId: string }).markerId)
    expect(ids[0]).toBe(ids[1])
    const payloads = markers.map((op) => (op.item as { payload?: Record<string, unknown> }).payload)
    expect(payloads[0]).toMatchObject({ state: 'running', reason: 'threshold' })
    expect(payloads[1]).toMatchObject({ state: 'completed' })
    // 压缩后副本已不可信：UI 要整页重取
    expect(fake.events.some((event) => event.type === 'timelineReset')).toBe(true)
  })

  test('适配器：没成的压缩报 cancelled 并带上错误文案，且不叫 UI 重取', async () => {
    const { fakeOmpSession, opsOf } = await import('./fixtures/omp-session')
    const fake = await fakeOmpSession()
    fake.feed({ type: 'auto_compaction_start', reason: 'overflow', action: 'context-full' })
    fake.feed({
      type: 'auto_compaction_end',
      action: 'context-full',
      result: undefined,
      aborted: true,
      errorMessage: 'boom',
    })

    const payloads = opsOf(fake.events)
      .filter((op) => op.op === 'marker.upsert')
      .map((op) => (op.item as { payload?: Record<string, unknown> }).payload)
    expect(payloads[1]).toMatchObject({ state: 'cancelled', error: 'boom' })
    /* 中止的那一次没有新副本可看，整页重取反而是白跑一趟 */
    expect(fake.events.some((event) => event.type === 'timelineReset')).toBe(false)
  })

  test('标记带上自己的时刻，且不碰时间线以外的东西', () => {
    const p = projector()
    const state = applyOps(
      emptyTimeline(),
      p.marker({ markerId: 'compaction-1', marker: 'compaction', payload: { state: 'completed' } }),
    )
    expect(state.items[0]).toMatchObject({ at: new Date(T0).toISOString() })
    expect(pageFromState(state).meta).toEqual({})
  })
})
