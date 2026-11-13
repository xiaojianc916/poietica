import { describe, expect, test } from 'bun:test'
import { EMPTY_THREAD_STATE, reduceAll, snapshotOf, type TranscriptPage } from '@poietica/agent-model'
import { eventsFromPage, pagesToPage } from '@poietica/feature-runs/core'

const at = '2026-11-08T00:00:00.000Z'

const page: TranscriptPage = {
  items: [
    { kind: 'marker', markerId: 'm1', marker: 'context.compacted', at },
    {
      kind: 'turn',
      turnId: 't1',
      ordinal: 1,
      state: 'completed',
      origin: { kind: 'user' },
      prompt: '做点事',
      startedAt: at,
      endedAt: at,
      steps: [
        {
          kind: 'step',
          stepId: 't1.1',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          startedAt: at,
          endedAt: at,
          frames: [
            { kind: 'thinking', frameId: 'f0', text: '想一下' },
            { kind: 'text', frameId: 'f1', role: 'assistant', text: '好了' },
          ],
        },
      ],
    },
    { kind: 'taskref', refId: 'r1', taskId: 'k1', at },
  ],
  tasks: [
    {
      taskId: 'k1',
      kind: 'shell',
      state: 'completed',
      detached: false,
      outputTail: 'ok',
      startedAt: at,
      endedAt: at,
    },
  ],
  interactions: [],
  attachments: [
    {
      attachmentId: 'a1',
      mediaType: 'image/png',
      name: 'a.png',
      size: 10,
      source: { kind: 'blob', sha256: 'abc' },
    },
  ],
  todos: [],
  prompts: [],
  meta: { activity: 'idle' },
}

describe('pagesToPage', () => {
  test('从新到旧的分页拼回轮序，侧表取头页', () => {
    const turn = page.items[1]
    if (turn?.kind !== 'turn') throw new Error('fixture 缺轮')
    const second = { ...turn, turnId: 't2', ordinal: 2, steps: [] }
    const head = { ...page, items: [second], hasMoreOlder: false }
    const older = { ...page, items: [turn], hasMoreOlder: true }
    const merged = pagesToPage([head, older])
    expect(merged?.items.map((item) => (item.kind === 'turn' ? item.turnId : item.kind))).toEqual(['t1', 't2'])
    expect(merged?.hasMoreOlder).toBe(false)
    expect(merged?.tasks).toEqual(head.tasks)
  })
})

describe('eventsFromPage', () => {
  test('轮/步/帧、marker/taskref、侧表都重建回同一页', () => {
    const events = eventsFromPage(page, 'th', 'main', at)
    const rebuilt = snapshotOf(reduceAll(EMPTY_THREAD_STATE, events))
    expect(rebuilt.items).toEqual(page.items)
    expect(rebuilt.tasks).toEqual(page.tasks)
    expect(rebuilt.attachments).toEqual(page.attachments)
    expect(rebuilt.meta.activity).toBe(page.meta.activity)
  })
})
