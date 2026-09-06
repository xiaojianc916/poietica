import { describe, expect, test } from 'bun:test'
import type { AgentTranscriptSnapshot, TranscriptFrame, TranscriptTurn } from '@poietica/transcript'
import { selectPresentation } from '../timeline/presentation'
import { allItems } from '../timeline/timeline-contract'
import { outlineOf, projectTranscript } from './transcript-projector'

describe('official transcript projection', () => {
  test('projects a complete turn without interpreting KAP events', () => {
    const state = projectTranscript({
      items: [
        {
          kind: 'turn',
          turnId: '1',
          ordinal: 1,
          state: 'completed',
          durationMs: 12_500,
          origin: { kind: 'user' },
          prompt: 'hello',
          steps: [
            {
              kind: 'step',
              stepId: 's',
              turnId: '1',
              ordinal: 1,
              state: 'completed',
              frames: [{ kind: 'text', frameId: 'f', role: 'assistant', text: 'world' }],
            },
          ],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
      hasMoreOlder: false,
    })
    expect(state.status).toBe('completed')
    expect(state.spans[0]?.durationMs).toBe(12_500)
    expect(state.active.items.map((item) => item.type)).toEqual(['user_message', 'agent_text'])
  })
})

function runSample(
  ordinal: number,
  origin: TranscriptTurn['origin'] = { kind: 'user' },
  frames?: TranscriptFrame[],
  state: TranscriptTurn['state'] = 'completed',
): TranscriptTurn {
  const turnId = `t${ordinal}`
  return {
    kind: 'turn',
    turnId,
    ordinal,
    origin,
    state,
    prompt: `prompt ${ordinal}`,
    steps: [
      {
        kind: 'step',
        stepId: `${turnId}.s`,
        turnId,
        ordinal: 1,
        state: 'completed',
        frames: frames ?? [
          { kind: 'text', frameId: `${turnId}.a`, role: 'assistant', text: 'answer' },
        ],
      },
    ],
  }
}

function snapshotOf(
  items: AgentTranscriptSnapshot['items'],
  prompts: AgentTranscriptSnapshot['prompts'] = [],
): AgentTranscriptSnapshot {
  return { items, prompts, tasks: [], interactions: [], attachments: [], todos: [], meta: {} }
}

function repliesOf(snapshot: AgentTranscriptSnapshot) {
  const state = projectTranscript(snapshot)
  const opened = new Map([...state.sealed, state.active].map((page) => [page.turn, true]))
  const feed = selectPresentation(state, opened)
  return Array.from({ length: feed.count }, (_, index) => feed.replyAt(index)).filter(
    (reply) => reply !== undefined,
  )
}

describe('run origin, completion and undo boundaries', () => {
  test('retains non-user text without user bubbles or question marks', () => {
    const origins: TranscriptTurn['origin'][] = [
      { kind: 'cron' },
      { kind: 'task', taskId: 'task' },
      { kind: 'hook' },
      { kind: 'compaction' },
      { kind: 'side' },
      { kind: 'other' },
    ]
    for (const [index, origin] of origins.entries()) {
      const snapshot = snapshotOf([runSample(index, origin)])
      const state = projectTranscript(snapshot)
      expect(state.active.items[0]?.type).toBe('run_trigger')
      expect(allItems(state).some((item) => item.type === 'user_message')).toBe(false)
      expect(outlineOf(snapshot)).toEqual([])
      expect(state.active.items[0]).toMatchObject({ text: `prompt ${index}` })
    }
  })

  test('role user alone is not evidence of a real user message', () => {
    const snapshot = snapshotOf([
      runSample(0, undefined, [
        { kind: 'text', frameId: 'human', role: 'user', origin: { kind: 'user' }, text: 'same' },
        { kind: 'text', frameId: 'task', role: 'user', taskId: 'job', text: 'same' },
        { kind: 'text', frameId: 'unknown', role: 'user', text: 'same' },
      ]),
    ])
    expect(projectTranscript(snapshot).active.items.map((item) => item.type)).toEqual([
      'user_message',
      'user_message',
      'run_trigger',
      'run_trigger',
    ])
  })

  test('an interjection never closes an earlier reply in the same run', () => {
    const frames: TranscriptFrame[] = [
      { kind: 'text', frameId: 'before', role: 'assistant', text: 'before' },
      { kind: 'text', frameId: 'steer', role: 'user', origin: { kind: 'user' }, text: 'steer' },
      { kind: 'text', frameId: 'after', role: 'assistant', text: 'after' },
    ]
    expect(repliesOf(snapshotOf([runSample(0, undefined, frames, 'running')]))).toEqual([])
    for (const state of ['completed', 'cancelled', 'failed'] as const) {
      const replies = repliesOf(snapshotOf([runSample(0, undefined, frames, state)]))
      expect(replies).toHaveLength(1)
      expect(replies[0]?.text).toBe('after')
    }
  })

  test('a later queued prompt disables fork, not copy of the finished run', () => {
    const replies = repliesOf(
      snapshotOf(
        [runSample(0)],
        [{ promptId: 'queued', status: 'queued', createdAt: '2026-09-06T00:00:00Z' }],
      ),
    )
    expect(replies).toHaveLength(1)
    expect(replies[0]?.undoCount).toBeNull()
    expect(replies[0]?.forkUnavailableReason).not.toBeNull()
  })

  test('user, task, user has an unreachable first run boundary', () => {
    const state = projectTranscript(
      snapshotOf([runSample(0), runSample(1, { kind: 'task', taskId: 'job' }), runSample(2)]),
    )
    expect(state.sealed[0]?.run?.undoCount).toBeNull()
    expect(state.sealed[1]?.run?.undoCount).toBe(1)
    expect(state.active.run?.undoCount).toBe(0)
  })

  test('an opening prompt and one steer are two undo anchors in one run', () => {
    const following = runSample(1, undefined, [
      { kind: 'text', frameId: 'steer', role: 'user', origin: { kind: 'user' }, text: 'steer' },
      { kind: 'text', frameId: 'answer', role: 'assistant', text: 'answer' },
    ])
    const state = projectTranscript(snapshotOf([runSample(0), following]))
    expect(state.sealed[0]?.run?.undoCount).toBe(2)
  })

  test('unknown frame provenance and merged prompts do not get guessed counts', () => {
    const frames: TranscriptFrame[] = [
      { kind: 'text', frameId: 'missing', role: 'user', text: 'unknown' },
      {
        kind: 'text',
        frameId: 'merged',
        role: 'user',
        origin: { kind: 'user' },
        promptIds: ['a', 'b'],
        text: 'merged',
      },
    ]
    for (const frame of frames) {
      const state = projectTranscript(snapshotOf([runSample(0), runSample(1, undefined, [frame])]))
      expect(state.sealed[0]?.run?.undoCount).toBeNull()
    }
  })

  test('shell input is visible user input but is not an undo anchor', () => {
    const shell = runSample(2, { kind: 'user', payload: { kind: 'shell_command', phase: 'input' } })
    const state = projectTranscript(snapshotOf([runSample(0), runSample(1), shell, runSample(3)]))
    expect(state.sealed[0]?.run?.undoCount).toBe(2)
    expect(state.sealed[1]?.run?.undoCount).toBeNull()
  })

  test('user-slash commands retain user identity and their undo anchor', () => {
    for (const kind of ['skill_activation', 'plugin_command']) {
      const command = runSample(1, { kind: 'other', payload: { kind, trigger: 'user-slash' } })
      const snapshot = snapshotOf([runSample(0), command])
      const state = projectTranscript(snapshot)
      expect(state.active.items[0]?.type).toBe('user_message')
      expect(state.sealed[0]?.run?.undoCount).toBe(1)
      expect(outlineOf(snapshot)).toHaveLength(2)
    }
  })

  test('compaction markers block older cuts without removing their copy action', () => {
    const snapshot = snapshotOf([
      runSample(0),
      { kind: 'marker', markerId: 'compact', marker: 'compaction' },
      runSample(1),
    ])
    const replies = repliesOf(snapshot)
    expect(replies).toHaveLength(2)
    expect(replies[0]?.undoCount).toBeNull()
    expect(replies[1]?.undoCount).toBe(0)
  })

  test('older pagination and a reset do not change the suffix counting unit', () => {
    const snapshot = { ...snapshotOf([runSample(3), runSample(4)]), hasMoreOlder: true }
    expect(projectTranscript(snapshot).sealed[0]?.run?.undoCount).toBe(1)
    const reset = projectTranscript(snapshotOf([runSample(3)]))
    expect(reset.sealed).toEqual([])
    expect(reset.active.run?.undoCount).toBe(0)
  })
})
