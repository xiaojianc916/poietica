import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyOps, emptyTimeline, pageFromState, type TranscriptItem } from '@poietica/transcript'
import { SUPERSEDED_SUMMARY } from '../compaction'
import { LiveProjector } from '../live'

/*
 * 压缩的桥侧。缘起是真实缺陷：omp 的压缩事件从前掉进 default: break，上下文被压缩时屏幕上
 * 什么都不说。判据里最重要的一条是「号要稳」：开门与关门共用同一个 markerId —— 换号会在屏幕上
 * 多出一行，人读到的是「上下文被压了两次」这种不存在的历史。这里钉的是**投影器自己**产出的
 * marker；token 数由关门那一格带上（审查 R-21：从前关门只带状态，完成那一行说不出压了多少）。
 */
const T0 = 1_700_000_000_000

function projector(): LiveProjector {
  return new LiveProjector({ now: () => T0 })
}

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
  test('开门与关门是同一条标记，时刻也留在开门处', () => {
    let now = T0
    const p = new LiveProjector({ now: () => now })
    const opened = p.compactionStart({ reason: 'threshold', action: 'context-full' })
    now += 15_000
    const { rows } = compactionRows([opened, p.compactionEnd({ state: 'completed' })])
    // 换号会在屏幕上多出一行；换时刻会让完成那一行越过压缩期间的工具调用。
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      markerId: 'compaction-live-1',
      at: new Date(T0).toISOString(),
      payload: { state: 'completed' },
    })
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

  test('适配器：开门与关门共用同一个号；收口不整页重取，并重报一次上下文占用（审查 R-21-2）', async () => {
    const { fakeOmpSession, opsOf } = await import('./fixtures/omp-session')
    const fake = await fakeOmpSession()
    fake.feed({ type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' })
    fake.feed({
      type: 'auto_compaction_end',
      action: 'context-full',
      result: { tokensBefore: 120_000, summary: '摘要' },
      aborted: false,
    })

    const markers = opsOf(fake.events).filter((op) => op.op === 'marker.upsert')
    expect(markers).toHaveLength(2)
    // 换号就会在屏幕上多出一行：两次事件必须落在同一个 markerId 上
    const ids = markers.map((op) => (op.item as { markerId: string }).markerId)
    expect(ids[0]).toBe(ids[1])
    const payloads = markers.map((op) => (op.item as { payload?: Record<string, unknown> }).payload)
    expect(payloads[0]).toMatchObject({ state: 'running', reason: 'threshold', action: 'context-full' })
    // 没有显示经过可读时退回事件里的 result：token 数照样带上
    expect(payloads[1]).toMatchObject({ state: 'completed', tokensBefore: 120_000, summary: '摘要' })
    /*
     * 从前这里整页重取：重取的那一页按压缩后的模型上下文算（前文全没了），而重置又丢掉了还没发出去的
     * 关门那一帧、换上历史那一格的 running —— 于是一直停在「正在压缩上下文…」。
     */
    expect(fake.events.some((event) => event.type === 'timelineReset')).toBe(false)
    expect(fake.events.some((event) => event.type === 'contextUsage')).toBe(true)
  })

  test('适配器：收口的 token 数以 omp 刚落盘的那条摘要为准（tokensAfter 只在条目上）', async () => {
    const { fakeOmpSession, opsOf } = await import('./fixtures/omp-session')
    const transcript: Record<string, unknown>[] = [
      { role: 'user', timestamp: T0, content: '问' },
      { role: 'assistant', timestamp: T0 + 1, content: [{ type: 'text', text: '答' }] },
    ]
    const fake = await fakeOmpSession({ transcript })
    fake.feed({ type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' })
    transcript.push({
      role: 'compactionSummary',
      timestamp: T0 + 2,
      summary: '整份摘要',
      shortSummary: '短摘要',
      tokensBefore: 120_000,
      tokensAfter: 18_000,
    })
    fake.feed({
      type: 'auto_compaction_end',
      action: 'context-full',
      result: { tokensBefore: 119_000, summary: '整份摘要' },
      aborted: false,
      willRetry: false,
    })

    const last = opsOf(fake.events)
      .filter((op) => op.op === 'marker.upsert')
      .at(-1) as { item: { payload: Record<string, unknown> } }
    expect(last.item.payload).toMatchObject({
      state: 'completed',
      tokensBefore: 120_000,
      tokensAfter: 18_000,
      shortSummary: '短摘要',
    })
  })

  test('适配器：被中止的压缩报 cancelled 并带上错误文案', async () => {
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
    expect(fake.events.some((event) => event.type === 'timelineReset')).toBe(false)
  })

  test('适配器：omp 报错（没中止）是 failed，不是 cancelled；换一种方式再压另起一行', async () => {
    const { fakeOmpSession, opsOf } = await import('./fixtures/omp-session')
    const fake = await fakeOmpSession()
    fake.feed({ type: 'auto_compaction_start', reason: 'threshold', action: 'handoff' })
    fake.feed({
      type: 'auto_compaction_end',
      action: 'handoff',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'Auto-handoff returned no document',
    })
    fake.feed({ type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' })
    fake.feed({
      type: 'auto_compaction_end',
      action: 'context-full',
      result: { tokensBefore: 90_000 },
      aborted: false,
      willRetry: false,
    })

    const markers = opsOf(fake.events)
      .filter((op) => op.op === 'marker.upsert')
      .map((op) => op.item as { markerId: string; payload: Record<string, unknown> })
    expect(markers.map((marker) => marker.payload.state)).toEqual(['running', 'failed', 'running', 'completed'])
    expect(markers[1]?.payload).toMatchObject({ error: 'Auto-handoff returned no document' })
    // 同一轮里两次压缩：两行，不是后一次盖掉前一次
    expect(new Set(markers.map((marker) => marker.markerId)).size).toBe(2)
  })

  test('适配器：跳过的压缩（没有可压的）撤掉开门那一格，不留一行「完成」', async () => {
    const { fakeOmpSession, opsOf } = await import('./fixtures/omp-session')
    const fake = await fakeOmpSession()
    fake.feed({ type: 'auto_compaction_start', reason: 'idle', action: 'context-full' })
    fake.feed({
      type: 'auto_compaction_end',
      action: 'context-full',
      result: undefined,
      aborted: false,
      willRetry: false,
      skipped: true,
    })

    const ops = opsOf(fake.events)
    const opened = ops.find((op) => op.op === 'marker.upsert') as { item: { markerId: string } }
    const state = applyOps(emptyTimeline(), ops as unknown as Parameters<typeof applyOps>[1])
    expect(ops.at(-1)).toEqual({ op: 'items.remove', ids: [opened.item.markerId] })
    expect(state.items.filter((item) => item.kind === 'marker')).toHaveLength(0)
  })

  test('适配器：分页与落座读显示经过，不读压缩后的模型上下文（审查 R-21-1）', async () => {
    const { fakeOmpSession } = await import('./fixtures/omp-session')
    const summary = { role: 'compactionSummary', timestamp: T0 + 20, summary: '前两轮的摘要', tokensBefore: 9 }
    const fake = await fakeOmpSession({
      // 模型上下文：压缩之后只剩摘要 + 之后的那一句
      messages: [summary, { role: 'user', timestamp: T0 + 30, content: '第三问' }],
      transcript: [
        { role: 'user', timestamp: T0, content: '第一问' },
        { role: 'assistant', timestamp: T0 + 1, content: [{ type: 'text', text: '第一答' }] },
        { role: 'user', timestamp: T0 + 10, content: '第二问' },
        summary,
        { role: 'user', timestamp: T0 + 30, content: '第三问' },
      ],
    })
    const page = await fake.session.page('main', null)
    expect(page.items.flatMap((item) => (item.kind === 'turn' ? [`${item.turnId}:${item.prompt ?? ''}`] : []))).toEqual(
      ['t1:第一问', 't2:第二问', 't3:第三问'],
    )
    expect(page.items.flatMap((item) => (item.kind === 'marker' ? [item.markerId] : []))).toEqual(['compaction-2-1'])
    // 落座（打开会话时）与分页各读一次；没开着轮就不让 omp 保留悬挂调用
    expect(fake.transcriptReads.length).toBeGreaterThanOrEqual(2)
    for (const read of fake.transcriptReads) {
      expect(read).toEqual({ collapseCompactedHistory: false, keepInFlightToolCalls: false })
    }
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

/* omp 知识 #19 / #20 的钉子：升级 omp 后这几处变了，显示经过的读法与占位判据就得跟着重看 */
describe('omp 显示经过（R-21）', () => {
  const read = (specifier: string): string => readFileSync(fileURLToPath(import.meta.resolve(specifier)), 'utf8')

  test('AgentSession 仍有 buildTranscriptSessionContext，且收 collapseCompactedHistory / keepInFlightToolCalls', () => {
    const source = read('@oh-my-pi/pi-coding-agent/session/agent-session')
    expect(source).toContain('buildTranscriptSessionContext(')
    /* 选项类型是 omp 自己的：适配器直接引它，改名时 typecheck 会抓到（18.11 起 keepDanglingToolCalls → keepInFlightToolCalls） */
    const options = read('@oh-my-pi/pi-coding-agent/session/session-context')
    expect(options).toContain('interface TranscriptSessionContextOptions')
    expect(options).toContain('"collapseCompactedHistory"')
    expect(options).toContain('keepInFlightToolCalls?: boolean')
    expect(options).not.toContain('keepDanglingToolCalls')
  })

  test('被取代的摘要占位与我们认的那一句一致', () => {
    const source = read('@oh-my-pi/pi-coding-agent/session/session-context')
    expect(source).toContain(`const SUPERSEDED_COMPACTION_SUMMARY = "${SUPERSEDED_SUMMARY}";`)
  })
})
