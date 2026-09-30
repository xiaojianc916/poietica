/*
 * 子代理可观测面 → transcript task 行。
 *
 * 这一支此前完全没有生产者：omp 的 subagentEventBus 被丢掉了，而 contract 里
 * `task.upsert` 与 `kind: 'subagent'` 早就钉好，后台任务面板也早会画。这个文件钉的是
 * 桥这一半的判据 —— 尤其是「终态不许被翻回运行中」与「同样的进度不重复发」。
 *
 * 自检跑法：bun test src/__tests__/subagents.test.ts
 */

import { expect, test } from 'bun:test'
import { applyOperation, EMPTY_AGENT_STATE } from '@poietica/transcript'
import { SubagentLedger } from '../subagents.ts'

/** 固定时钟：ops 里的时刻可断言，测试之间不互相漂。 */
function ledger(at = Date.parse('2026-01-01T00:00:00.000Z')): SubagentLedger {
  return new SubagentLedger({ now: () => at })
}

/** 把 ops 喂进 transcript，交出真正的 task 行。 */
function applied(ops: readonly ReturnType<SubagentLedger['lifecycle']>[number][]) {
  let state = EMPTY_AGENT_STATE
  for (const op of ops) {
    state = applyOperation(state, op).state
  }
  return state.tasks
}

const STARTED = {
  id: 'scout',
  agent: 'task',
  description: '看一遍仓库',
  status: 'started',
  detached: true,
  index: 0,
}

test('a spawned subagent becomes one subagent row', () => {
  const ops = ledger().lifecycle(STARTED)

  expect(ops).toHaveLength(1)
  const tasks = applied(ops)
  expect(tasks.get('scout')).toMatchObject({
    taskId: 'scout',
    kind: 'subagent',
    state: 'running',
    detached: true,
    description: '看一遍仓库',
    outputTail: '',
    startedAt: '2026-01-01T00:00:00.000Z',
    /* 屏幕那一行要一个可寻址的身份；omp 的 lifecycle id 就是它签的输出号。 */
    agentId: 'scout',
  })
  // 还在跑的行没有结束时刻：编一个就是报了一件没发生的事。
  expect(tasks.get('scout')?.endedAt).toBeUndefined()
})

test('every omp lifecycle status maps to one transcript state', () => {
  // aborted 是「人把它停了」，落 killed；timed_out 说的是超时，那是另一件事。
  expect(ledger().lifecycle({ ...STARTED, status: 'completed' })[0]).toMatchObject({
    task: { state: 'completed', endedAt: '2026-01-01T00:00:00.000Z' },
  })
  expect(ledger().lifecycle({ ...STARTED, status: 'failed' })[0]).toMatchObject({
    task: { state: 'failed' },
  })
  expect(ledger().lifecycle({ ...STARTED, status: 'aborted' })[0]).toMatchObject({
    task: { state: 'killed' },
  })
})

test('a status omp never sends is dropped rather than guessed', () => {
  // 认不出的词猜成 failed 会让屏幕上凭空多一行「失败」。
  expect(ledger().lifecycle({ ...STARTED, status: 'paused' })).toEqual([])
  expect(ledger().lifecycle({ id: 'x' })).toEqual([])
  expect(ledger().lifecycle(null)).toEqual([])
  expect(ledger().lifecycle('not a frame')).toEqual([])
})

test('a settled row is never flipped back to running', () => {
  const l = ledger()
  l.lifecycle({ ...STARTED, status: 'completed' })

  // 迟到的 started 不许把已经完成的账改假。
  expect(l.lifecycle(STARTED)).toEqual([])
  expect(l.tasks[0]?.state).toBe('completed')
})

test('progress carries the metrics and keeps the lifecycle state', () => {
  const l = ledger()
  l.lifecycle(STARTED)

  const ops = l.progress({
    index: 0,
    task: '看一遍仓库',
    detached: true,
    progress: {
      id: 'scout',
      status: 'running',
      lastIntent: '读 README',
      recentOutput: ['第一行', '第二行'],
      resolvedModel: 'anthropic/claude',
      resolvedThinkingLevel: 'high',
    },
  })

  expect(applied(ops).get('scout')).toMatchObject({
    state: 'running',
    description: '读 README',
    outputTail: '第一行\n第二行',
    model: 'anthropic/claude',
    thinkingEffort: 'high',
  })
})

test('an identical progress frame produces no ops', () => {
  const l = ledger()
  l.lifecycle(STARTED)

  const frame = { progress: { id: 'scout', status: 'running', lastIntent: '读 README' } }
  expect(l.progress(frame)).toHaveLength(1)
  // omp 每 150ms 推一条；原样转发就是每 150ms 一次整格替换。
  expect(l.progress(frame)).toEqual([])
})

test('a progress frame after the row settled changes nothing', () => {
  const l = ledger()
  l.lifecycle({ ...STARTED, status: 'completed' })

  expect(l.progress({ progress: { id: 'scout', status: 'running' } })).toEqual([])
  expect(l.tasks[0]?.state).toBe('completed')
})

test('progress without an identity is dropped', () => {
  expect(ledger().progress({ progress: { status: 'running' } })).toEqual([])
  expect(ledger().progress({})).toEqual([])
  expect(ledger().progress(undefined)).toEqual([])
})

test('progress arriving before the lifecycle row still lands', () => {
  // 重连时只会看到进度：那一行确实在跑，落 running 而不是丢掉。
  const ops = ledger().progress({
    progress: { id: 'scout', status: 'running', lastIntent: '读 README' },
  })

  expect(applied(ops).get('scout')).toMatchObject({ state: 'running', kind: 'subagent' })
})

test('a full run lands one row carrying the start, the tail and the end', () => {
  /* 一条子代理从生到死：三帧、一行，起止时刻与输出尾巴都在。 */
  const l = ledger()
  const rows = applied([
    ...l.lifecycle(STARTED),
    ...l.progress({ progress: { id: 'scout', status: 'running', recentOutput: ['日志'] } }),
    ...l.lifecycle({ ...STARTED, status: 'completed' }),
  ])
  expect(rows.get('scout')).toMatchObject({
    state: 'completed',
    description: '看一遍仓库',
    outputTail: '日志',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.000Z',
  })
})
