/*
 * 投影器的自检：喂进一串事件，把吐出的 ops 按 ops/apply.ts 的规矩落一遍。
 *
 * 这里不重抄 appendAtOffset 的判据，而是直接用它 —— 投影错了（offset 接不上）
 * apply 会报 gap，测试就红。
 */

import { describe, expect, it } from 'bun:test'

import { applyOperation, EMPTY_AGENT_STATE } from '@poietica/transcript'

import { TranscriptProjector } from '../projection.ts'

type Op = ReturnType<TranscriptProjector['turnEnd']>[number]

/** 把一串 op 落到状态上，返回 (状态, 有无 gap)。 */
function settle(ops: readonly Op[]) {
  let state = EMPTY_AGENT_STATE
  let gapped = false

  for (const op of ops) {
    const result = applyOperation(state, op)
    if (result.gap !== undefined) {
      gapped = true
    }
    state = result.state
  }

  const turn = (id: string) => {
    const item = state.items.find((entry) => entry.kind === 'turn' && entry.turnId === id)
    return item?.kind === 'turn' ? item : undefined
  }

  return { state, gapped, turn }
}

describe('omp 事件投影成 transcript ops', () => {
  it('一轮正文流式追加：offset 逐条接得上，apply 不报 gap', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('读一下 README')]

    for (const chunk of ['你', '好', '，世界']) {
      ops.push(...projector.textDelta(chunk))
    }

    const { gapped, turn } = settle(ops)
    expect(gapped).toBe(false)

    expect(turn('t1')?.prompt).toBe('读一下 README')

    const assistant = turn('t1')?.steps[0]?.frames.find(
      (frame) => frame.kind === 'text' && frame.role === 'assistant',
    )
    expect(assistant).toMatchObject({ kind: 'text', text: '你好，世界' })
  })

  it('工具调用同 id 覆盖：从 running 走到 done，不是两帧', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('跑一下')]

    ops.push(
      ...projector.toolStart({ toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }),
    )
    ops.push(...projector.toolEnd({ toolCallId: 'c1', toolName: 'bash', result: 'a.ts\nb.ts' }))

    const { turn } = settle(ops)
    const tools = (turn('t1')?.steps[0]?.frames ?? []).filter((frame) => frame.kind === 'tool')

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ kind: 'tool', toolCallId: 'c1', state: 'done' })
  })

  /*
   * 覆盖是整格替换（ops/apply.ts 的 applyFrameUpsert），所以结果那一帧必须把入参带回来。
   * 不带的话，path/command 在结果到达那一刻就被抹掉：一次读文件退成没有路径的
   * 「读取文件」，送出去的那一面也空了。
   */
  it('结果那一帧把入参一起带回来，路径与命令不会被抹掉', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('读一下')]

    ops.push(
      ...projector.toolStart({ toolCallId: 'c1', toolName: 'read', args: { path: 'src/a.ts' } }),
    )
    ops.push(
      ...projector.toolEnd({
        toolCallId: 'c1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'const a = 1' }] },
      }),
    )

    const { turn } = settle(ops)
    const tool = (turn('t1')?.steps[0]?.frames ?? []).find((frame) => frame.kind === 'tool')

    expect(tool).toMatchObject({ state: 'done', input: { path: 'src/a.ts' } })
  })

  /*
   * 官方在 tool_execution_update 里发 partialResult（bash 的 tail 每 50ms 一次），
   * 从前桥的 default 把它整条丢掉 —— 一条跑三分钟的 bash 屏幕上从「运行中」直接
   * 跳终态。接上之后：同一帧被覆盖成中间输出，state 仍是 running，入参不丢。
   */
  it('工具的中间结果覆盖同一帧，状态仍是运行中且入参还在', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('跑一下')]

    ops.push(
      ...projector.toolStart({ toolCallId: 'c1', toolName: 'bash', args: { command: 'npm test' } }),
    )
    ops.push(
      ...projector.toolUpdate({
        toolCallId: 'c1',
        toolName: 'bash',
        partial: { stdout: '第一个用例过了' },
      }),
    )

    const { turn } = settle(ops)
    const tools = (turn('t1')?.steps[0]?.frames ?? []).filter((frame) => frame.kind === 'tool')

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'c1',
      state: 'running',
      input: { command: 'npm test' },
      output: { stdout: '第一个用例过了' },
    })
  })

  it('中间结果之后结果照旧覆盖同一帧，终态不被中间态挡住', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('跑一下')]

    ops.push(...projector.toolStart({ toolCallId: 'c2', toolName: 'bash', args: {} }))
    ops.push(...projector.toolUpdate({ toolCallId: 'c2', toolName: 'bash', partial: '半截' }))
    ops.push(...projector.toolEnd({ toolCallId: 'c2', toolName: 'bash', result: '整段' }))

    const { turn } = settle(ops)
    const tools = (turn('t1')?.steps[0]?.frames ?? []).filter((frame) => frame.kind === 'tool')

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ state: 'done', output: '整段' })
  })

  /*
   * 挂了技能的那一句要把技能写进 origin：屏幕上的 chip 只认 origin.payload 的
   * skillActivations（transcript-projector 的 skillNamesOf），而它从前全仓无生产者 ——
   * 于是「这一句挂了技能」在任何一帧里都不存在，chip 永远画不出来。
   */
  it('挂技能的那一轮把技能写进 origin，屏幕据此画得出 chip', () => {
    const projector = new TranscriptProjector()

    const ops = projector.userTurn('看看这个', [], 'p1', undefined, undefined, [
      { name: 'review' },
      { name: 'ponytail', args: 'ultra' },
    ])

    const { turn } = settle(ops)
    const origin = turn('t1')?.origin

    expect(origin).toMatchObject({
      kind: 'user',
      payload: {
        kind: 'skill_activation',
        skillActivations: [{ skillName: 'review' }, { skillName: 'ponytail', skillArgs: 'ultra' }],
      },
    })
  })

  it('没挂技能时 origin 保持原样，不编一个空的技能表', () => {
    const projector = new TranscriptProjector()

    const { turn } = settle(projector.userTurn('没有技能'))

    expect(turn('t1')?.origin).toEqual({ kind: 'user' })
  })

  it('没有开轮时的中间结果也被丢掉，不凭空造 turn', () => {
    const projector = new TranscriptProjector()

    expect(projector.toolUpdate({ toolCallId: 'x', toolName: 'bash', partial: '早' })).toEqual([])
  })

  it('失败的工具调用落 error，并把结果写进 error 文案', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('跑一下')]

    ops.push(...projector.toolStart({ toolCallId: 'c9', toolName: 'bash', args: {} }))
    ops.push(
      ...projector.toolEnd({
        toolCallId: 'c9',
        toolName: 'bash',
        result: 'boom',
        isError: true,
      }),
    )

    const { turn } = settle(ops)
    const tool = (turn('t1')?.steps[0]?.frames ?? []).find((frame) => frame.kind === 'tool')

    expect(tool).toMatchObject({ kind: 'tool', state: 'error', error: 'boom' })
  })

  it('正文与思维链各占一帧：换流不会把两种字混进同一帧', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('想一下')]

    ops.push(...projector.thinkingDelta('先看'))
    ops.push(...projector.textDelta('答案'))

    const { gapped, turn } = settle(ops)
    expect(gapped).toBe(false)

    const frames = turn('t1')?.steps[0]?.frames ?? []
    const thinking = frames.find((frame) => frame.kind === 'thinking')
    const assistant = frames.find((frame) => frame.kind === 'text' && frame.role === 'assistant')

    expect(thinking).toMatchObject({ kind: 'thinking', text: '先看' })
    expect(assistant).toMatchObject({ kind: 'text', text: '答案' })
  })

  it('轮终把 turn 与 step 一起收掉，并把相位打回 idle', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('做点事')]
    ops.push(...projector.textDelta('做完了'))
    ops.push(...projector.turnEnd('completed'))

    const { state, turn } = settle(ops)

    expect(turn('t1')?.state).toBe('completed')
    expect(turn('t1')?.steps[0]?.state).toBe('completed')
    expect(state.meta.activity).toBe('idle')
  })

  it('取消与失败落各自的状态，不是都叫 completed', () => {
    for (const [outcome, expected, stepState] of [
      ['cancelled', 'cancelled', 'interrupted'],
      ['failed', 'failed', 'failed'],
    ] as const) {
      const projector = new TranscriptProjector()
      const ops: Op[] = [...projector.userTurn('做点事')]
      ops.push(...projector.turnEnd(outcome))

      const { turn } = settle(ops)
      expect(turn('t1')?.state).toBe(expected)
      expect(turn('t1')?.steps[0]?.state).toBe(stepState)
    }
  })

  it('没有开轮时来的增量被丢掉，不凭空造 turn', () => {
    const projector = new TranscriptProjector()

    expect(projector.textDelta('孤儿')).toEqual([])
    expect(projector.toolStart({ toolCallId: 'x', toolName: 'bash', args: {} })).toEqual([])
    expect(projector.turnEnd('completed')).toEqual([])
  })

  it('第二条用户消息开第二个 turn，编号递增', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('第一句')]
    ops.push(...projector.turnEnd('completed'))
    ops.push(...projector.userTurn('第二句'))

    const { gapped, turn } = settle(ops)
    expect(gapped).toBe(false)
    expect(turn('t1')?.prompt).toBe('第一句')
    expect(turn('t2')?.prompt).toBe('第二句')
  })

  /*
   * 账本那个号必须一路跟到收轮。
   *
   * 屏幕靠 `triggerPromptId` 把「刚提交、还没落地」的那条记录认回这一轮
   * （transcript-projector.ts 的 knownPromptIds）。丢了它，那条记录永远收不掉：
   * 发送键一直转，取消还会说「消息仍在提交」。
   *
   * 收轮那一趟尤其要看：`turn.upsert` 是整格替换，"带不带" 两半都得对。
   */
  it('提交的号挂在开轮与收轮两处，收轮不会把它冲掉', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('做点事', [], 'turn-abc')]

    expect(
      ops.some((op) => op.op === 'turn.upsert' && op.turn.triggerPromptId === 'turn-abc'),
    ).toBe(true)

    ops.push(...projector.turnEnd('completed'))

    const { turn } = settle(ops)
    expect(turn('t1')?.triggerPromptId).toBe('turn-abc')
    expect(turn('t1')?.state).toBe('completed')
  })

  it('没有提交号时不编一个：那一格保持缺席', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('做点事')]
    ops.push(...projector.turnEnd('completed'))

    const { turn } = settle(ops)
    expect(turn('t1')?.triggerPromptId).toBeUndefined()
  })

  /*
   * 插话落在哪一格，是这一整套里最容易画错的一处：
   *
   * 开着一轮时它是**那一轮里的一句**（模型在工具批次之间看见它，然后接着干同一轮的活），
   * 所以它进同一个 turn、另起一帧；没开着一轮时（followUp 在轮终之后被排成下一轮）
   * 它就是这句话自己开的开场白。
   */
  describe('插话帧', () => {
    it('开着一轮：进当前 turn，且封掉正在流的那一帧', () => {
      const projector = new TranscriptProjector()
      const ops: Op[] = [...projector.userTurn('干活')]
      ops.push(...projector.textDelta('先做一半'))
      ops.push(...projector.steeredFrame('停，改这里'))
      ops.push(...projector.textDelta('接着做'))

      const { gapped, turn } = settle(ops)
      expect(gapped).toBe(false)

      const steps = turn('t1')?.steps ?? []
      expect(steps).toHaveLength(1)

      const frames = steps[0]?.frames ?? []
      expect(frames.map((frame) => (frame.kind === 'text' ? frame.text : frame.kind))).toEqual([
        '干活',
        '先做一半',
        '停，改这里',
        '接着做',
      ])
      /* 人说的话必须带 origin：投影层认「这是人说的」只看那一格。 */
      const interjection = frames[2]
      expect(interjection?.kind === 'text' && interjection.origin).toEqual({ kind: 'user' })
      /* 没有第二个 turn：插话不是新的一轮。 */
      expect(turn('t2')).toBeUndefined()
    })

    it('没开着一轮：这句话自己开一轮', () => {
      const projector = new TranscriptProjector()
      const ops: Op[] = [...projector.userTurn('第一轮')]
      ops.push(...projector.turnEnd('completed'))
      /* followUp 在轮终之后被排成下一轮，桥收到的是同一条注入消息。 */
      ops.push(...projector.steeredFrame('排队的那一句'))

      const { gapped, turn } = settle(ops)
      expect(gapped).toBe(false)
      expect(turn('t1')?.prompt).toBe('第一轮')
      expect(turn('t2')?.prompt).toBe('排队的那一句')
    })
  })
})
/*
 * 号是按**位置**算的：屏幕上一格一位置，而显示经过里工具结果是独立一格、摘要也是。
 * 增量那条路自己数不到那里（它只看得见自己开过几轮），所以它必须接受"坐到某一格上"。
 * 判据：坐位之后开的那一轮，号就是座位后面那一个 —— 不是它自己数出来的那一个。
 */
describe('投影器坐到屏幕的位置上', () => {
  const ordinalsOf = (ops: readonly Op[]): number[] =>
    ops.filter((op) => op.op === 'turn.upsert').map((op) => op.turn.ordinal)

  it('坐位之后开的那一轮用座位后面的号', () => {
    const projector = new TranscriptProjector()

    projector.seat(7)

    expect(ordinalsOf(projector.userTurn('继续'))).toEqual([8])
  })

  it('收尾把号停在座位上：下一轮接着排，不复用旧号', () => {
    const projector = new TranscriptProjector()

    projector.seat(7)
    projector.userTurn('继续')
    const ended = projector.turnEnd('completed')

    expect(ordinalsOf(ended)).toEqual([8])
    expect(ordinalsOf(projector.userTurn('再继续'))).toEqual([9])
  })

  it('开着轮时不改号：那一轮自己已经写在号上了', () => {
    const projector = new TranscriptProjector()

    projector.userTurn('第一句')
    projector.seat(99)

    expect(projector.turnOrdinal).toBe(1)
    expect(ordinalsOf(projector.turnEnd('completed'))).toEqual([1])
  })

  it('指定座位开轮时以它为准，正文跟着走', () => {
    const projector = new TranscriptProjector()

    const opened = projector.userTurn('翻回来的一格', [], undefined, undefined, { ordinal: 42 })

    expect(ordinalsOf(opened)).toEqual([42])
    expect(opened.find((op) => op.op === 'turn.upsert')).toMatchObject({
      turn: { turnId: 't42', prompt: '翻回来的一格' },
    })
  })
})
