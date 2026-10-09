import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState, type TranscriptFrame } from '@poietica/transcript'
import { TOOL_FALLBACK_TEXT } from '../live'
import { framesOf, projector, snapshot } from './fixtures/live'

describe('LiveProjector', () => {
  test('纯文本：分两段 append 拼成完整正文', () => {
    const p = projector()
    p.userTurn({ text: '你好' })
    const ops = [...p.textDelta('Hel'), ...p.textDelta('lo'), ...p.turnEnd('completed', null)]
    const state = applyOps(emptyTimeline(), ops)
    expect(snapshot(state).texts).toEqual(['Hello'])
  })

  test('思考 + 文本各占一帧', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const state = applyOps(emptyTimeline(), [...p.thinkingDelta('想'), ...p.textDelta('答')])
    expect(snapshot(state).thoughts).toEqual(['想'])
    expect(snapshot(state).texts).toEqual(['答'])
  })

  test('工具帧：start → update → end 覆盖同一帧，入参与意图保留', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const start = p.toolStart({ toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' }, intent: '看文件' })
    const update = p.toolUpdate({ toolCallId: 'c1', toolName: 'read', partial: '前半' })
    const end = p.toolEnd({ toolCallId: 'c1', toolName: 'read', result: '全文' })
    const state = applyOps(emptyTimeline(), [...start, ...update, ...end])
    expect(snapshot(state).tools).toEqual(['read:done:全文'])
    const turn = state.items[0]
    const frame = turn?.kind === 'turn' ? turn.steps[0]?.frames[0] : undefined
    expect(frame?.kind === 'tool' && frame.input).toEqual({ path: 'a.ts' })
    expect(frame?.kind === 'tool' && frame.intent).toBe('看文件')
  })

  test('工具出错：state 为 error 且 error 文本落地', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const ops = [
      ...p.toolStart({ toolCallId: 'c1', toolName: 'bash', args: {} }),
      ...p.toolEnd({ toolCallId: 'c1', toolName: 'bash', result: 'boom', isError: true }),
    ]
    const state = applyOps(emptyTimeline(), ops)
    const turn = state.items[0]
    const frame = turn?.kind === 'turn' ? turn.steps[0]?.frames[0] : undefined
    expect(frame?.kind === 'tool' && frame.state).toBe('error')
    expect(frame?.kind === 'tool' && frame.error).toBe('boom')
  })

  test('插话：开着一轮时进当前 step 并封掉正在流的帧', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const ops = [...p.textDelta('前半'), ...p.steeredFrame('插一句'), ...p.textDelta('后半')]
    const state = applyOps(emptyTimeline(), ops)
    const texts: string[] = []
    const roles: string[] = []
    for (const item of state.items) {
      if (item.kind !== 'turn') continue
      for (const step of item.steps)
        for (const frame of step.frames) {
          if (frame.kind === 'text') {
            texts.push(frame.text)
            roles.push(frame.role)
          }
        }
    }
    // 插话封掉正在流的那一帧，下一段正文另起一帧，所以顺序是：前半、插话、后半
    expect(texts).toEqual(['前半', '插一句', '后半'])
    expect(roles).toEqual(['assistant', 'user', 'assistant'])
  })

  test('没开着一轮时插话退回新的一轮', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    p.turnEnd('completed', null)
    const ops = p.steeredFrame('下一句')
    const state = applyOps(emptyTimeline(), ops)
    const turns = state.items.filter((i) => i.kind === 'turn')
    expect(turns.length).toBe(1)
    expect(turns[0]?.kind === 'turn' && turns[0].prompt).toBe('下一句')
  })

  test('turnEnd 收 step 与 turn，并 merge activity: idle', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    p.textDelta('答')
    const ops = p.turnEnd('failed', '出错了')
    const state = applyOps(emptyTimeline(), ops)
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.state).toBe('failed')
    expect(turn?.kind === 'turn' && turn.error).toBe('出错了')
    expect(state.meta.activity).toBe('idle')
  })

  test('seat 只在没开着轮时改号', () => {
    const p = projector()
    p.seat(4)
    expect(p.turnOrdinal).toBe(4)
    p.userTurn({ text: 'q' })
    expect(p.turnOrdinal).toBe(5)
    p.seat(99)
    expect(p.turnOrdinal).toBe(5)
  })

  test('notice 落在当前 step，不绑轮也能生成 marker', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const ops = [...p.notice('warning', '小心', 'omp'), ...p.marker({ markerId: 'm1', marker: 'compaction' })]
    const state = applyOps(emptyTimeline(), ops)
    const turn = state.items[0]
    const frames: TranscriptFrame[] = turn?.kind === 'turn' ? (turn.steps[0]?.frames ?? []) : []
    expect(frames.some((f) => f.kind === 'notice' && f.message === '小心')).toBe(true)
    expect(state.items.some((i) => i.kind === 'marker' && i.markerId === 'm1')).toBe(true)
  })

  test('没开轮时所有流式与工具调用都不产出 op', () => {
    const p = projector()
    expect(p.textDelta('x')).toEqual([])
    expect(p.thinkingDelta('x')).toEqual([])
    expect(p.toolStart({ toolCallId: 'c', toolName: 't', args: {} })).toEqual([])
    expect(p.turnEnd('completed', null)).toEqual([])
  })

  test('相位 meta.merge 每档只报一次（同一相位不重复合并）', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const first = p.textDelta('a')
    const second = p.textDelta('b')
    expect(first.some((op) => op.op === 'meta.merge')).toBe(true)
    expect(second.some((op) => op.op === 'meta.merge')).toBe(false)
    const state = applyOps(emptyTimeline(), [...first, ...second])
    expect(pageFromState(state).items.length).toBe(1)
  })

  /*
   * 工具事件投影失败时的降级帧（R-02 §2.5、§4 的 P1–P4）。它不得抛异常 —— 事件泵已经
   * 在异常路径上了，兜底再抛就没人接。
   */
  test('toolFallback：已经 start 过的格沿用同一个 frameId，并带回 input', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    p.toolStart({ toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } })
    const ops = p.toolFallback({ toolCallId: 'c1', toolName: 'read', ended: true })
    const state = applyOps(emptyTimeline(), ops)
    const turn = state.items[0]
    const frame = turn?.kind === 'turn' ? turn.steps[0]?.frames.at(-1) : undefined
    expect(frame?.kind === 'tool' && frame.frameId).toBe('tool.c1')
    expect(frame?.kind === 'tool' && frame.state).toBe('error')
    expect(frame?.kind === 'tool' && frame.error).toBe(TOOL_FALLBACK_TEXT)
    expect(frame?.kind === 'tool' && frame.input).toEqual({ path: 'a.ts' })
  })

  test('toolFallback：没 start 过的格会封掉正在流的正文，之后另起一帧', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    const before = p.textDelta('前半')
    const fallback = p.toolFallback({ toolCallId: 'c9', toolName: 'bash', ended: null })
    const after = p.textDelta('后半')

    const state = applyOps(emptyTimeline(), [...before, ...fallback, ...after])
    // 降级帧把正文封死，后半段因此另起一帧（顺序：前半、降级工具格、后半）
    expect(snapshot(state).texts).toEqual(['前半', '后半'])
    const tools = framesOf(state).filter((frame) => frame.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.kind === 'tool' && tools[0].frameId).toBe('tool.c9')
    expect(tools[0]?.kind === 'tool' && tools[0].state).toBe('running')
  })

  test('toolFallback 在没开着轮时返回空', () => {
    const p = projector()
    expect(p.toolFallback({ toolCallId: 'c1', toolName: 'read', ended: true })).toEqual([])
  })

  test('abandonTurn：轮关掉之后插话退回成新的一轮', () => {
    const p = projector()
    p.userTurn({ text: 'q' })
    p.abandonTurn()
    expect(p.isTurnOpen).toBe(false)
    const ops = p.steeredFrame('下一句')
    const state = applyOps(emptyTimeline(), ops)
    const turns = state.items.filter((item) => item.kind === 'turn')
    const latest = turns.at(-1)
    expect(latest?.kind === 'turn' && latest.prompt).toBe('下一句')
  })

  test('turnEnd 之后的累加器状态与 abandonTurn 完全一致', () => {
    // 同样的操作序列跑两遍：一遍正常收轮（turnEnd），一遍只复位（abandonTurn）。
    // 收轮之后从同一个位置再开一轮，两边的产出必须逐字段相同 —— 这是「两处复位不会漂移」的判据。
    const closed = projector()
    closed.userTurn({ text: 'q' })
    closed.toolStart({ toolCallId: 'c1', toolName: 'read', args: {} })
    closed.turnEnd('completed', null)

    const abandoned = projector()
    abandoned.userTurn({ text: 'q' })
    abandoned.toolStart({ toolCallId: 'c1', toolName: 'read', args: {} })
    abandoned.abandonTurn()

    expect(closed.isTurnOpen).toBe(abandoned.isTurnOpen)
    expect(closed.turnOrdinal).toBe(abandoned.turnOrdinal)
    expect(closed.toolFallback({ toolCallId: 'c1', toolName: 'read', ended: true })).toEqual(
      abandoned.toolFallback({ toolCallId: 'c1', toolName: 'read', ended: true }),
    )

    const first = applyOps(emptyTimeline(), closed.userTurn({ text: '下一句' }))
    const second = applyOps(emptyTimeline(), abandoned.userTurn({ text: '下一句' }))
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
