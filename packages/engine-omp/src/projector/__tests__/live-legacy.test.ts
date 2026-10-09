import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState } from '@poietica/transcript'
import { LiveProjector } from '../live'
import { framesOf, iso, projector, snapshot } from './fixtures/live'

/*
 * 迁移自 legacy projection.test.ts、screen-turns.test.ts、live-image-attachments.test.ts
 * 的屏幕侧那一半（12 页 §12.3 的去向表）：断言意图一条不删，只把输入换成 LiveProjector 的接口。
 *
 * 两处 legacy 有、新接口表达不了的（在完成汇报里点名，不在这里假绿）：
 *   - legacy 的 userTurn 能直接指定「屏幕上已有那一格」的号；新接口只有 seat(n)（下一号 = n + 1），
 *     等价表达见「指定座位开轮」那一条。
 *   - legacy 的 skills 每一项带 args（写进 origin 的 skillArgs）；新接口只收技能名（方案 §7.4 的形状）。
 */
describe('正文、工具与轮终的完整链（legacy projection.test.ts）', () => {
  test('正文逐段追加：offset 逐条接得上，applyOps 不抛缺口，prompt 不被流式覆盖', () => {
    const p = projector()
    let state = applyOps(emptyTimeline(), p.userTurn({ text: '读一下 README' }))
    for (const chunk of ['你', '好', '，世界']) {
      // 每一条增量单独 apply：offset 接不上时 applyOps 抛 TranscriptGapError，这一条当场红
      state = applyOps(state, p.textDelta(chunk))
    }
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.prompt).toBe('读一下 README')
    expect(snapshot(state).texts).toEqual(['你好，世界'])
  })

  test('中间结果之后结果照旧覆盖同一帧，终态不被中间态挡住', () => {
    const p = projector()
    p.userTurn({ text: '跑一下' })
    const ops = [
      ...p.toolStart({ toolCallId: 'c2', toolName: 'bash', args: {} }),
      ...p.toolUpdate({ toolCallId: 'c2', toolName: 'bash', partial: '半截' }),
      ...p.toolEnd({ toolCallId: 'c2', toolName: 'bash', result: '整段' }),
    ]
    const state = applyOps(emptyTimeline(), ops)
    const tools = framesOf(state).filter((frame) => frame.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ state: 'done', output: '整段' })
  })

  test('没开轮时的中间结果也被丢掉，不凭空造 turn', () => {
    const p = projector()
    expect(p.toolUpdate({ toolCallId: 'x', toolName: 'bash', partial: '早' })).toEqual([])
  })

  test('挂技能的那一轮把技能写进 origin，屏幕据此画得出 chip', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), p.userTurn({ text: '看看这个', skills: ['review', 'ponytail'] }))
    const turn = state.items[0]
    // chip 的真产地：origin.payload.skillActivations（transcript-projector 的 skillNamesOf 只读它）
    expect(turn?.kind === 'turn' && turn.origin).toMatchObject({
      kind: 'user',
      payload: {
        kind: 'skill_activation',
        skillActivations: [{ skillName: 'review' }, { skillName: 'ponytail' }],
      },
    })
  })

  test('没挂技能时 origin 保持原样，不编一个空的技能表', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), p.userTurn({ text: '没有技能' }))
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.origin).toEqual({ kind: 'user' })
  })

  test('第二条用户消息开第二个 turn，编号递增', () => {
    const p = projector()
    let state = applyOps(emptyTimeline(), p.userTurn({ text: '第一句' }))
    state = applyOps(state, p.turnEnd('completed', null))
    state = applyOps(state, p.userTurn({ text: '第二句' }))
    const turns = state.items.filter((item) => item.kind === 'turn')
    expect(turns.map((turn) => turn.prompt)).toEqual(['第一句', '第二句'])
    expect(turns.map((turn) => turn.turnId)).toEqual(['t1', 't2'])
  })
})

/*
 * 提交号（triggerPromptId）：屏幕靠它把「刚提交、还没落地」的那条记录认回这一轮
 * （transcript-projector 的 knownPromptIds）。丢了它，那条记录永远收不掉：发送键一直转。
 * 收轮那一趟尤其要看：turn.upsert 是整格替换，"带不带" 两半都得对。
 */
describe('提交号挂在开轮与收轮两处（legacy projection.test.ts）', () => {
  test('收轮不会把提交号冲掉', () => {
    const p = projector()
    const opened = p.userTurn({ text: '做点事', promptId: 'turn-abc' })
    expect(opened.some((op) => op.op === 'turn.upsert' && op.turn.triggerPromptId === 'turn-abc')).toBe(true)
    const state = applyOps(applyOps(emptyTimeline(), opened), p.turnEnd('completed', null))
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.triggerPromptId).toBe('turn-abc')
    expect(turn?.kind === 'turn' && turn.state).toBe('completed')
  })

  test('没有提交号时不编一个：那一格保持缺席', () => {
    const p = projector()
    const state = applyOps(applyOps(emptyTimeline(), p.userTurn({ text: '做点事' })), p.turnEnd('completed', null))
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.triggerPromptId).toBeUndefined()
  })
})

describe('结局与段封口（legacy projection.test.ts / screen-turns.test.ts）', () => {
  test('取消与失败落各自的状态，不是都叫 completed', () => {
    const cases = [
      ['cancelled', 'cancelled', 'interrupted'],
      ['failed', 'failed', 'failed'],
      ['completed', 'completed', 'completed'],
    ] as const
    for (const [outcome, turnState, stepState] of cases) {
      const p = projector()
      const state = applyOps(applyOps(emptyTimeline(), p.userTurn({ text: '做点事' })), p.turnEnd(outcome, null))
      const turn = state.items[0]
      expect(turn?.kind === 'turn' && turn.state).toBe(turnState)
      expect(turn?.kind === 'turn' && turn.steps[0]?.state).toBe(stepState)
    }
  })

  test('收尾把段封口：在跑的那一轮里不能留下永远转圈的段', () => {
    const p = projector()
    p.userTurn({ text: '一句' })
    const closed = p.turnEnd('completed', null)
    for (const op of closed) {
      if (op.op === 'step.upsert') expect(op.step.state).toBe('completed')
    }
    const state = applyOps(emptyTimeline(), closed)
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.steps[0]?.endedAt).toBeDefined()
  })

  test('封条的两头取自不同时刻：开场那一刻 → 收轮那一刻', () => {
    let at = 1_700_000_000_000
    const p = new LiveProjector({ now: () => at })
    const opened = p.userTurn({ text: '一句' })
    at += 90_000
    const closed = p.turnEnd('completed', null)

    const opening = opened.find((op) => op.op === 'turn.upsert')
    const closing = closed.find((op) => op.op === 'turn.upsert')
    expect(opening).toMatchObject({ turn: { startedAt: iso(1_700_000_000_000) } })
    expect(closing).toMatchObject({
      turn: { startedAt: iso(1_700_000_000_000), endedAt: iso(1_700_000_090_000) },
    })
    // 两头不是同一个时刻 —— 同一个时刻就是屏幕上那行「已处理 0 秒」
    expect(iso(1_700_000_000_000)).not.toBe(iso(1_700_000_090_000))
  })

  test('取消那一轮收尾之后，屏幕上没有 error 这一格', () => {
    const p = projector()
    p.userTurn({ text: '一句' })
    // outcomeOf 把 aborted 判成 cancelled 且 message 为 null（errors.test.ts 另有一条）
    const state = applyOps(emptyTimeline(), p.turnEnd('cancelled', null))
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.state).toBe('cancelled')
    expect(turn?.kind === 'turn' && turn.error).toBeUndefined()
  })
})

describe('插话帧（legacy projection.test.ts 的「插话帧」）', () => {
  test('开着一轮：进当前 turn 另起一帧，且封掉正在流的那一帧', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), [
      ...p.userTurn({ text: '干活' }),
      ...p.textDelta('先做一半'),
      ...p.steeredFrame('停，改这里'),
      ...p.textDelta('接着做'),
    ])
    const turn = state.items[0]
    const steps = turn?.kind === 'turn' ? turn.steps : []
    expect(steps).toHaveLength(1)
    const frames = steps[0]?.frames ?? []
    expect(frames.map((frame) => (frame.kind === 'text' ? frame.text : frame.kind))).toEqual([
      '干活',
      '先做一半',
      '停，改这里',
      '接着做',
    ])
    // 人说的话必须带 origin：投影层认「这是人说的」只看那一格
    const interjection = frames[2]
    expect(interjection?.kind === 'text' && interjection.origin).toEqual({ kind: 'user' })
    // 没有第二个 turn：插话不是新的一轮
    expect(state.items.filter((item) => item.kind === 'turn')).toHaveLength(1)
  })

  test('没开着一轮：这句话自己开一轮，上一轮的话还在', () => {
    const p = projector()
    let state = applyOps(emptyTimeline(), p.userTurn({ text: '第一轮' }))
    state = applyOps(state, p.turnEnd('completed', null))
    state = applyOps(state, p.steeredFrame('排队的那一句'))
    const turns = state.items.filter((item) => item.kind === 'turn')
    expect(turns.map((turn) => turn.prompt)).toEqual(['第一轮', '排队的那一句'])
    expect(turns.map((turn) => turn.turnId)).toEqual(['t1', 't2'])
  })
})

/*
 * 号是按**位置**算的：屏幕上一格一位置。增量这条路自己数不到那里（它只看得见自己开过几轮），
 * 所以它必须接受「坐到某一格上」。判据：坐位之后开的那一轮，号就是座位后面那一个。
 */
describe('投影器坐到屏幕的位置上（legacy projection.test.ts / screen-turns.test.ts）', () => {
  test('座位之后开的那一轮用座位后面的号，收尾把号停在座位上', () => {
    const p = projector()
    p.seat(7)
    const opened = p.userTurn({ text: '继续' })
    expect(opened.filter((op) => op.op === 'turn.upsert').map((op) => op.turn.ordinal)).toEqual([8])
    const ended = p.turnEnd('completed', null)
    expect(ended.filter((op) => op.op === 'turn.upsert').map((op) => op.turn.ordinal)).toEqual([8])
    expect(
      p
        .userTurn({ text: '再继续' })
        .filter((op) => op.op === 'turn.upsert')
        .map((op) => op.turn.ordinal),
    ).toEqual([9])
  })

  test('开着轮时不改号：那一轮自己已经写在号上了', () => {
    const p = projector()
    p.userTurn({ text: '第一句' })
    p.seat(99)
    expect(p.turnOrdinal).toBe(1)
    expect(
      p
        .turnEnd('completed', null)
        .filter((op) => op.op === 'turn.upsert')
        .map((op) => op.turn.ordinal),
    ).toEqual([1])
  })

  test('指定座位开轮时以它为准（legacy 的 at.ordinal 等价于先 seat 一位）', () => {
    const p = projector()
    p.seat(41)
    const opened = p.userTurn({ text: '翻回来的一格' })
    expect(opened.find((op) => op.op === 'turn.upsert')).toMatchObject({
      turn: { turnId: 't42', prompt: '翻回来的一格' },
    })
  })

  test('座位数出屏幕上已有的 3 轮之后，接着说话从第 4 轮起', () => {
    const p = projector()
    p.seat(3)
    const opened = p.userTurn({ text: '第四句' })
    expect(opened.filter((op) => op.op === 'turn.upsert').map((op) => op.turn.ordinal)).toEqual([4])
    expect(p.isTurnOpen).toBe(true)
  })
})

/*
 * 现场发送的图片上屏（legacy live-image-attachments.test.ts 的屏幕那一侧）。
 *
 * legacy 的链是「同一号上先有一条能画的 attachment.upsert，然后 turn 引用它」，
 * 新接口由 LiveProjector.attachmentOp 出这条 upsert（12 页 §7.4 第 3 步）。
 */
describe('现场图片上屏（legacy live-image-attachments.test.ts）', () => {
  /** 一张 1×1 的 PNG，够证明「像素过得了这条线」而不必带大文件 */
  const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  test('图片先落一条能画的 attachment.upsert，再开一轮引用它', () => {
    const p = projector()
    const attachmentId = 'shot.png#0'
    const ops = [
      ...p.attachmentOp({
        attachmentId,
        mediaType: 'image/png',
        dataUrl: `data:image/png;base64,${PIXEL}`,
        name: 'shot.png',
      }),
      ...p.userTurn({ text: '这是什么', attachmentIds: [attachmentId] }),
    ]
    const state = applyOps(emptyTimeline(), ops)

    /* 屏幕那一边：同一个号上是一条能画的 upsert（界面按 url 源直接画） */
    expect(state.attachments.get(attachmentId)).toMatchObject({
      mediaType: 'image/png',
      name: 'shot.png',
      source: { kind: 'url', url: `data:image/png;base64,${PIXEL}` },
    })
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.attachmentIds).toEqual([attachmentId])

    /*
     * upsert 必须先于引用它的 turn 落地：反过来的话投影层先看到 turn，
     * 那一格引用一个还不存在的附件，屏幕上就是一块空白。
     */
    expect(ops.findIndex((op) => op.op === 'attachment.upsert')).toBeLessThan(
      ops.findIndex((op) => op.op === 'turn.upsert'),
    )
  })

  test('非图片附件不是一张画得出来的图：没有像素就没有 attachment.upsert', () => {
    const p = projector()
    // 普通文件由 agent 按 @路径 自己读（prompt.ts 那条路），屏幕上不该多出一块画不出来的空图
    const ops = p.userTurn({ text: '看看这个\n@C:/work/notes.txt' })
    expect(ops.some((op) => op.op === 'attachment.upsert')).toBe(false)
    const state = applyOps(emptyTimeline(), ops)
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.attachmentIds).toBeUndefined()
  })

  test('turn 与它下面那一帧都引用附件的号', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), p.userTurn({ text: '这是什么', attachmentIds: ['shot.png'] }))
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.attachmentIds).toEqual(['shot.png'])
    const frame = turn?.kind === 'turn' ? turn.steps[0]?.frames[0] : undefined
    expect(frame?.kind === 'text' && frame.attachmentIds).toEqual(['shot.png'])
  })

  test('没有附件时不编一个空表', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), p.userTurn({ text: '没有图' }))
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.attachmentIds).toBeUndefined()
  })
})

describe('一轮的代表性形状（12 页 §9.5 的快照）', () => {
  test('正文 + 思考 + 工具中间结果 + 轮终：整页快照一次看全', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), [
      ...p.userTurn({ text: '跑一下测试', promptId: 'p-1', skills: ['review'] }),
      ...p.thinkingDelta('先想一下'),
      ...p.toolStart({ toolCallId: 'c1', toolName: 'bash', args: { command: 'npm test' }, intent: '跑测试' }),
      ...p.toolUpdate({ toolCallId: 'c1', toolName: 'bash', partial: { stdout: '第一个用例过了' } }),
      ...p.toolEnd({
        toolCallId: 'c1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '全绿' }] },
      }),
      ...p.textDelta('做完了'),
      ...p.turnEnd('completed', null, { input: 10, output: 20, cacheRead: 3 }),
    ])
    expect(pageFromState(state)).toMatchSnapshot()
  })
})
