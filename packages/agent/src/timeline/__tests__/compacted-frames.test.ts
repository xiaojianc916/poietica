import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { SAMPLE_RUN_EVENTS } from '../__fixtures__/sample-run'
import { allItems } from '../timeline-contract'
import { replayRunEvents } from '../timeline-reducer'

/**
 * 同一轮，两段相邻的思考已经并好。
 *
 * 手写而不是从样例折出来：折一遍就是第二份实现，那时测的是两份实现是否一致，
 * 而这里唯一值得断言的是 reducer 分不分得出这两者。
 */
const COMPACTED_RUN_EVENTS: readonly RunEvent[] = [
  {
    kind: 'run_started',
    seq: 1,
    at: 1_000,
    sessionId: 'sess_demo',
    prompt: '把 README 里的构建命令核对一遍',
  },
  {
    kind: 'kap_event',
    seq: 2,
    at: 1_010,
    payload: { type: 'thinking.delta', delta: '先读取 README，再与 package.json 对照。' },
  },
  {
    kind: 'kap_event',
    seq: 4,
    at: 1_050,
    payload: {
      type: 'tool.call.started',
      toolCallId: 'call_1',
      name: 'Read README.md',
      args: { path: 'README.md' },
      display: { kind: 'file_io', operation: 'read', path: 'README.md' },
    },
  },
  {
    kind: 'kap_event',
    seq: 5,
    at: 1_090,
    payload: { type: 'tool.result', toolCallId: 'call_1', output: '# Poietica ...' },
  },
  {
    kind: 'kap_event',
    seq: 6,
    at: 1_100,
    payload: { type: 'assistant.delta', delta: '构建命令与 scripts 一致。' },
  },
  { kind: 'run_finished', seq: 7, at: 1_110, stopReason: 'completed' },
]

describe('compacted frames', () => {
  /* 存档快照赖以成立的性质：不成立，就是「重开一条对话」与「当时看着它发生」
     不同，那时该走的是压缩，不是这条断言。 */
  it('replays to exactly what the unfolded frames replay to', () => {
    const fromLog = replayRunEvents(SAMPLE_RUN_EVENTS)
    const fromSnapshot = replayRunEvents(COMPACTED_RUN_EVENTS)

    expect(allItems(fromSnapshot)).toEqual(allItems(fromLog))
    expect(fromSnapshot.status).toBe(fromLog.status)
  })

  it('would not survive joining two different sorts of fragment', () => {
    /* 并到思考与回答之间就停：它们是两条条目，并起来会让存档说出实时那一轮
       从没说过的话。 */
    const across: readonly RunEvent[] = [
      { kind: 'kap_event', seq: 1, at: 1, payload: { type: 'thinking.delta', delta: '想' } },
      { kind: 'kap_event', seq: 2, at: 2, payload: { type: 'assistant.delta', delta: '说' } },
    ]

    expect(allItems(replayRunEvents(across)).map((item) => item.type)).toEqual([
      'agent_thought',
      'agent_text',
    ])
  })
})
