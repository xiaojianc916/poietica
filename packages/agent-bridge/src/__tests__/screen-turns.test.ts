/*
 * 屏幕上的「一轮」是怎么切出来的。
 *
 * 缘起是一个真实的缺陷：上一版把**一条消息**当成一轮，于是一次对话（模型每跑一趟就是一条
 * assistant 消息 + 一条 toolResult）在屏幕上裂成十几行「已处理 0 秒」，而用户那句永远停在
 * 「正在处理」（没人给它封口）。正确的切法与官方 TUI 一致：一轮从「人说的话」开始，到下一句
 * 人话为止；模型跑过的每一趟是这一轮里的段。
 *
 * 另两条同批修好的规则也钉在这里：
 *  - 时间必须给成真实的一对（开场 → 最后一次说话），两头取自同一条消息就是「0 秒」；
 *  - omp 给合成横幅打的 `display: false`（目标模式的 <goal_context>）不上屏。
 *
 * 自检跑法：bun test src/__tests__/screen-turns.test.ts
 */

import { expect, test } from 'bun:test'
import { applyOperation, EMPTY_AGENT_STATE } from '@poietica/transcript'

import { outcomeOf } from '../outcome.ts'
import { TranscriptProjector } from '../projection.ts'

const FRAME = 'f1'

/** 一条能落进 reducer 的最小文本帧。 */
function textOp(turn: string, step: number, text: string, role: 'user' | 'assistant') {
  return {
    op: 'frame.upsert' as const,
    turnId: turn,
    stepId: `${turn}.${String(step)}`,
    frame: { kind: 'text' as const, role, frameId: `${turn}.${String(step)}.${FRAME}`, text },
  }
}

/** 一轮的终局形状：屏幕上那一行封条要的两头。 */
function sealOf(turn: { startedAt?: string; endedAt?: string; state: string }) {
  return {
    end: turn.endedAt,
    running: turn.state === 'running',
    start: turn.startedAt,
  }
}

test('一轮的号与段号：投影器按屏幕的轮号起号，收尾把号停在那一轮', () => {
  const projector = new TranscriptProjector()

  /* 屏幕上已有 3 轮（重开一条会话时铺过），接着说话要从第 4 轮起。 */
  projector.seat(3)

  const opened = projector.userTurn('第四句', [], undefined, '2026-01-01T00:00:00.000Z')

  expect(opened.filter((op) => op.op === 'turn.upsert').map((op) => op.turn.ordinal)).toEqual([4])
  expect(projector.isTurnOpen).toBe(true)
})

test('封条的两头取自不同时刻：开场那一刻 → 最后一步那一刻', () => {
  const projector = new TranscriptProjector()

  const started = '2026-01-01T00:00:00.000Z'
  const ended = '2026-01-01T00:01:30.000Z'

  const opened = projector.userTurn('一句', [], undefined, started)
  const closed = projector.turnEnd('completed', undefined, ended)

  /* 开轮那一刻是这一轮的起点；收轮那一刻是终点。 */
  const opening = opened.find((op) => op.op === 'turn.upsert')
  const closing = closed.find((op) => op.op === 'turn.upsert')

  expect(opening).toMatchObject({ turn: { startedAt: started } })
  expect(closing).toMatchObject({ turn: { startedAt: started, endedAt: ended } })

  /* 两头不是同一个时刻 —— 同一个时刻就是屏幕上那行「已处理 0 秒」。 */
  const turn = closing?.op === 'turn.upsert' ? closing.turn : undefined

  expect(turn?.startedAt).not.toBe(turn?.endedAt)
})

test('收尾把段封口：在跑的那一轮里不能留下永远转圈的段', () => {
  const projector = new TranscriptProjector()

  projector.userTurn('一句')
  const closed = projector.turnEnd('completed')

  for (const op of closed) {
    if (op.op === 'step.upsert') {
      expect(op.step.state).toBe('completed')
    }
  }
})

test('落进 reducer 之后，屏幕上那一轮的终局是 completed 且两头都有值', () => {
  let state = EMPTY_AGENT_STATE

  for (const op of [
    {
      op: 'turn.upsert' as const,
      turn: {
        kind: 'turn' as const,
        turnId: 't1',
        ordinal: 1,
        state: 'running' as const,
        origin: { kind: 'user' as const },
        prompt: '一句',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    textOp('t1', 0, '一句', 'user'),
    {
      op: 'turn.upsert' as const,
      turn: {
        kind: 'turn' as const,
        turnId: 't1',
        ordinal: 1,
        state: 'completed' as const,
        origin: { kind: 'user' as const },
        prompt: '一句',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:30.000Z',
      },
    },
  ]) {
    const result = applyOperation(state, op)

    expect(result.gap).toBeUndefined()
    state = result.state
  }

  const item = state.items[0]

  expect(item?.kind).toBe('turn')

  if (item?.kind === 'turn') {
    expect(sealOf(item)).toEqual({
      end: '2026-01-01T00:01:30.000Z',
      running: false,
      start: '2026-01-01T00:00:00.000Z',
    })
  }
})

/*
 * 按停止键那一趟的整条链：上游落在最后一条 assistant 消息上的那一句，经结局判据与
 * 投影器落到 reducer，屏幕上**不长出** error 那一格。
 *
 * 缺陷正是从这条链上漏出来的：`aborted` 那一档把 `Request was aborted` 当成了给人看
 * 的报错带走，errorItemOf 于是照它建一格，屏幕上就给一轮取消挂一条报错横幅。
 */
test('取消那一轮收尾之后，屏幕上没有 error 这一格', () => {
  const projector = new TranscriptProjector()

  projector.userTurn('一句')
  const outcome = outcomeOf({ stopReason: 'aborted', errorMessage: 'Request was aborted' })
  const closed = projector.turnEnd(outcome.kind, outcome.message)

  let state = EMPTY_AGENT_STATE

  for (const op of closed) {
    state = applyOperation(state, op).state
  }

  expect(outcome).toEqual({ kind: 'cancelled' })

  /* 那一轮自己仍然在屏幕上，只是状态是取消而不是失败，且没有报错那一格。 */
  const turn = state.items[0]

  expect(turn?.kind === 'turn' && turn.state).toBe('cancelled')
  expect(turn?.kind === 'turn' && turn.error).toBeUndefined()
})
