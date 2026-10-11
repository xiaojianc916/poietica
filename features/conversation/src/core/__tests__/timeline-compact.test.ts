import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import { COMPACT_LOOKBACK, compactOps, estimateChars } from '../timeline-compact'

/*
 * 批内压缩只做等价变换（性能审查 P-05）。
 *
 * 等价的判据是真实的应用函数：压缩前、压缩后各折叠到空状态，结果必须 toEqual。
 * 最后一条是随机序列的对拍：手写用例覆盖不到的交错由它兜底。
 */

const AT = '2026-10-10T00:00:00.000Z'
const TURN = 't1'
const STEP = 't1:s0'

const skeleton: TranscriptOperation[] = [
  {
    op: 'turn.upsert',
    turn: { kind: 'turn', turnId: TURN, ordinal: 1, state: 'running', origin: { kind: 'user' }, startedAt: AT },
  },
  {
    op: 'step.upsert',
    turnId: TURN,
    step: { kind: 'step', stepId: STEP, turnId: TURN, ordinal: 0, state: 'running', startedAt: AT },
  },
] as unknown as TranscriptOperation[]

const text = (frameId: string, body: string): TranscriptOperation =>
  ({
    op: 'frame.upsert',
    turnId: TURN,
    stepId: STEP,
    frame: { kind: 'text', frameId, role: 'assistant', text: body },
  }) as TranscriptOperation

const append = (frameId: string, offset: number, body: string): TranscriptOperation => ({
  op: 'append',
  target: { type: 'frame', turnId: TURN, stepId: STEP, frameId },
  offset,
  text: body,
})

const tool = (frameId: string, state: 'running' | 'done', output: string): TranscriptOperation =>
  ({
    op: 'frame.upsert',
    turnId: TURN,
    stepId: STEP,
    frame: { kind: 'tool', frameId, toolCallId: frameId, name: 'bash', state, output },
  }) as TranscriptOperation

const task = (taskId: string, outputTail: string): TranscriptOperation =>
  ({
    op: 'task.upsert',
    task: { taskId, kind: 'subagent', state: 'running', detached: false, outputTail },
  }) as TranscriptOperation

const meta = (n: number): TranscriptOperation =>
  ({ op: 'meta.merge', meta: { activity: 'turn' }, marker: n }) as unknown as TranscriptOperation

/** 在骨架之上依次应用；压缩前后各跑一遍对比 */
const fold = (ops: readonly TranscriptOperation[]) => applyOps(emptyTimeline(), [...skeleton, ...ops])

function expectEquivalent(ops: readonly TranscriptOperation[]): readonly TranscriptOperation[] {
  const compacted = compactOps(ops)
  expect(fold(compacted)).toEqual(fold(ops))
  return compacted
}

/** 线性同余：可复现的伪随机，失败时能原样重放 */
function seeded(start: number): (n: number) => number {
  let seed = start
  return (n) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
    return seed % n
  }
}

/* 一条随机 op。append 只发在「已有正文」的格子上、offset 接在末尾 —— 序列本身必须合法 */
function randomOp(random: (n: number) => number, lengths: Map<string, number>, at: number): TranscriptOperation {
  const id = `f${String(random(3))}`
  const kind = random(6)
  const length = lengths.get(id)
  if (kind <= 1 && length !== undefined) {
    const chunk = 'abc'.slice(0, 1 + random(3))
    lengths.set(id, length + chunk.length)
    return append(id, length, chunk)
  }
  if (kind === 2) {
    const body = 'z'.repeat(random(4))
    lengths.set(id, body.length)
    return text(id, body)
  }
  if (kind === 3) return tool(`g${String(random(3))}`, random(2) === 0 ? 'running' : 'done', String(at))
  if (kind === 4) return task(`k${String(random(2))}`, String(at))
  return meta(at)
}

function randomOps(random: (n: number) => number, count: number): TranscriptOperation[] {
  const lengths = new Map<string, number>()
  return Array.from({ length: count }, (_, at) => randomOp(random, lengths, at))
}

describe('P-05 compactOps', () => {
  test('C1 同一格 30 条首尾相接的 append 拼成 1 条', () => {
    const ops = [text('f0', ''), ...Array.from({ length: 30 }, (_, at) => append('f0', at, 'x'))]
    const compacted = expectEquivalent(ops)
    expect(compacted.length).toBe(2)
    expect(compacted[1]).toEqual(append('f0', 0, 'x'.repeat(30)))
  })

  test('C2 offset 不相接不拼（缺口原样交给 UI 去发现）', () => {
    const ops = [append('f0', 0, 'abc'), append('f0', 5, 'x')]
    expect(compactOps(ops)).toBe(ops)
  })

  test('C3 两格交替追加：不拼、不改顺序，交回原数组', () => {
    const ops = [text('a', ''), text('b', ''), append('a', 0, '1'), append('b', 0, '2'), append('a', 1, '3')]
    expect(expectEquivalent(ops)).toBe(ops)
  })

  test('C4 同一格的整格替换：后者内容放进前者的槽位，中间首次出现的格子顺序不变', () => {
    const ops = [tool('A', 'running', 'v1'), tool('B', 'running', 'b'), tool('A', 'running', 'v2')]
    const compacted = expectEquivalent(ops)
    expect(compacted).toEqual([tool('A', 'running', 'v2'), tool('B', 'running', 'b')])
  })

  test('C5 items.remove 是屏障：两侧的同格替换不合并', () => {
    const remove = { op: 'items.remove', ids: ['nothing'] } as TranscriptOperation
    const ops = [tool('A', 'running', 'v1'), remove, tool('A', 'running', 'v2')]
    expect(compactOps(ops)).toBe(ops)
  })

  test('C6 替换与追加交错在同一格上：顺序有意义，不合并', () => {
    const ops = [text('T', ''), append('T', 0, 'ab'), text('T', 'xyz')]
    expect(expectEquivalent(ops)).toBe(ops)
  })

  test('C7 task.upsert 同号合并；中间的帧 op 可交换', () => {
    const ops = [task('k', 'one'), tool('A', 'running', 'a'), meta(1), task('k', 'two')]
    const compacted = expectEquivalent(ops)
    expect(compacted).toEqual([task('k', 'two'), tool('A', 'running', 'a'), meta(1)])
  })

  test('C8 中间有追加写到同一个任务上：不合并', () => {
    const toTask = { op: 'append', target: { type: 'task', taskId: 'k' }, offset: 3, text: '!' } as TranscriptOperation
    const ops = [task('k', 'one'), toTask, task('k', 'two')]
    expect(expectEquivalent(ops)).toBe(ops)
  })

  test('C9 往回最多找 COMPACT_LOOKBACK 条：更远的不合并（整批保持 O(n)）', () => {
    const between = Array.from({ length: COMPACT_LOOKBACK }, (_, at) => meta(at))
    const ops = [tool('A', 'running', 'v1'), ...between, tool('A', 'running', 'v2')]
    expect(compactOps(ops)).toBe(ops)
  })

  test('C10 不修改输入', () => {
    const ops = [tool('A', 'running', 'v1'), tool('A', 'running', 'v2')]
    const copy = [...ops]
    compactOps(ops)
    expect(ops).toEqual(copy)
  })

  test('C11 estimateChars：正文与工具输出按长度计，其它按常数', () => {
    expect(estimateChars([append('f0', 0, 'x'.repeat(1000))])).toBe(1000)
    expect(estimateChars([tool('A', 'done', 'y'.repeat(50_000))])).toBeGreaterThan(50_000)
    expect(estimateChars([meta(1)])).toBeLessThan(1000)
  })

  test('C12 随机序列对拍：500 组、每组 60 条，压缩前后折叠结果完全相同', () => {
    const random = seeded(20261011)
    for (let round = 0; round < 500; round += 1) {
      expectEquivalent(randomOps(random, 60))
    }
  })
  /*
   * 结构类 op 也参与交错：第二个 step 一开始不存在（帧插入先建骨架，step.upsert 后到），
   * turn / step 的 upsert 改状态，偶尔整轮 items.remove 再被后面的帧重建。
   */
  test('C13 随机序列含 turn/step upsert、未建骨架的 step 与 items.remove：300 组对拍', () => {
    const random = seeded(7)
    const steps = [STEP, 't1:s1']
    const structural = (at: number): TranscriptOperation => {
      const pick = random(4)
      if (pick === 0) return { op: 'items.remove', ids: [TURN] } as TranscriptOperation
      if (pick === 1) {
        return {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId: TURN,
            ordinal: 1,
            state: at % 2 === 0 ? 'running' : 'done',
            origin: { kind: 'user' },
            startedAt: AT,
          },
        } as unknown as TranscriptOperation
      }
      return {
        op: 'step.upsert',
        turnId: TURN,
        step: {
          kind: 'step',
          stepId: 't1:s1',
          turnId: TURN,
          ordinal: 1,
          state: at % 2 === 0 ? 'running' : 'done',
          startedAt: AT,
        },
      } as unknown as TranscriptOperation
    }
    const frame = (at: number): TranscriptOperation =>
      ({
        op: 'frame.upsert',
        turnId: TURN,
        stepId: steps[random(2)],
        frame: {
          kind: 'tool',
          frameId: `g${String(random(2))}`,
          toolCallId: 'c',
          name: 'bash',
          state: 'running',
          output: String(at),
        },
      }) as TranscriptOperation
    for (let round = 0; round < 300; round += 1) {
      const ops = Array.from({ length: 40 }, (_, at) => (random(3) === 0 ? structural(at) : frame(at)))
      expectEquivalent(ops)
    }
  })
})
