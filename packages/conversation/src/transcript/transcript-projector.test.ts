import { describe, expect, test } from 'bun:test'
import {
  AgentTranscript,
  type AgentTranscriptSnapshot,
  foldWireRecordFacts,
  groupMessagesIntoSnapshot,
  type TranscriptFrame,
  type TranscriptTurn,
} from '@poietica/transcript'
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
describe('tool identity and run presentation', () => {
  test('known tools keep their category before display and after cold restoration', () => {
    const samples = [
      ['Bash', { command: 'pwd' }, { kind: 'command', command: 'pwd' }, 'execute', 'pwd'],
      [
        'Read',
        { path: 'a.ts' },
        { kind: 'file_io', operation: 'read', path: '/repo/a.ts' },
        'read',
        'a.ts',
      ],
      [
        'Grep',
        { pattern: 'needle' },
        { kind: 'file_io', operation: 'grep', path: '/repo' },
        'search',
        'needle',
      ],
      [
        'Glob',
        { pattern: '*.ts' },
        { kind: 'file_io', operation: 'glob', path: '/repo' },
        'search',
        '*.ts',
      ],
      [
        'FetchURL',
        { url: 'https://example.com' },
        { kind: 'url_fetch', url: 'https://example.com' },
        'fetch',
        'https://example.com',
      ],
      [
        'Skill',
        { skill: 'review' },
        { kind: 'skill_call', skill_name: 'review' },
        'skill',
        'review',
      ],
    ] as const
    for (const [name, input, display, kind, subject] of samples) {
      const frame = {
        kind: 'tool',
        frameId: 'call',
        toolCallId: 'call',
        name,
        state: 'done',
      } as const
      for (const variant of [frame, { ...frame, input }, { ...frame, input, display }]) {
        const state = projectTranscript(snapshotOf([runSample(0, undefined, [variant])]))
        const tool = state.active.items.find((item) => item.type === 'tool_call')
        expect(tool?.kind).toBe(kind)
        if ('input' in variant) {
          expect(tool?.subject).toBe(subject)
          expect(tool?.requestContent.length).toBeGreaterThan(0)
        }
      }
    }
  })

  test('view identity is authoritative, case-insensitive, and not a substring guess', () => {
    const frames: TranscriptFrame[] = [
      { kind: 'tool', frameId: 'a', toolCallId: 'a', name: 'bash', state: 'done' },
      {
        kind: 'tool',
        frameId: 'b',
        toolCallId: 'b',
        name: 'custom',
        view: 'Read',
        state: 'done',
        input: { path: 'a.ts' },
      },
      { kind: 'tool', frameId: 'c', toolCallId: 'c', name: 'ReadEverything', state: 'done' },
    ]
    const state = projectTranscript(snapshotOf([runSample(0, undefined, frames)]))
    expect(
      state.active.items.filter((item) => item.type === 'tool_call').map((item) => item.kind),
    ).toEqual(['execute', 'read', 'other'])
  })

  test('a trailing tool is process; actions follow the visible run tail in both disclosure states', () => {
    const frames: TranscriptFrame[] = [
      { kind: 'text', frameId: 'intro', role: 'assistant', text: 'checking' },
      { kind: 'tool', frameId: 'call', toolCallId: 'call', name: 'Read', state: 'done' },
    ]
    const state = projectTranscript(snapshotOf([runSample(0, undefined, frames)]))
    for (const open of [false, true]) {
      const feed = selectPresentation(state, new Map([[0, open]]))
      expect(feed.sealAt(0)?.hasProcess).toBe(true)
      expect(feed.replyAt(feed.count - 1)?.text).toBe('checking')
      for (let index = 0; index < feed.count - 1; index += 1) {
        expect(feed.replyAt(index)).toBeUndefined()
      }
      expect(feed.count).toBe(open ? 3 : 1)
    }
    const final = projectTranscript(
      snapshotOf([
        runSample(0, undefined, [
          ...frames,
          { kind: 'text', frameId: 'answer', role: 'assistant', text: 'done' },
        ]),
      ]),
    )
    const feed = selectPresentation(final, new Map())
    expect(feed.count).toBe(2)
    expect(feed.replyAt(1)?.text).toBe('done')
  })

  test('failure without final text still has an expandable process and visible error', () => {
    const run = runSample(
      0,
      undefined,
      [
        { kind: 'thinking', frameId: 'thought', text: 'reasoning' },
        { kind: 'tool', frameId: 'call', toolCallId: 'call', name: 'Read', state: 'error' },
      ],
      'failed',
    )
    const state = projectTranscript(snapshotOf([{ ...run, error: 'boom' }]))
    const collapsed = selectPresentation(state, new Map())
    expect(collapsed.sealAt(0)?.hasProcess).toBe(true)
    expect(collapsed.rowAt(collapsed.count - 1)?.item).toMatchObject({
      type: 'error',
      message: 'boom',
    })
    const expanded = selectPresentation(state, new Map([[0, true]]))
    expect(expanded.count).toBe(4)
    expect(expanded.replyAt(expanded.count - 1)).toBeUndefined()
  })

  test('a trailing error is visible once and precedes reply actions', () => {
    const run = runSample(
      0,
      undefined,
      [
        { kind: 'text', frameId: 'answer', role: 'assistant', text: 'answer' },
        { kind: 'notice', frameId: 'error', level: 'error', message: 'boom' },
      ],
      'failed',
    )
    const state = projectTranscript(snapshotOf([{ ...run, error: 'boom' }]))
    expect(allItems(state).filter((item) => item.type === 'error')).toHaveLength(1)
    const feed = selectPresentation(state, new Map())
    expect(feed.count).toBe(3)
    expect(feed.sealAt(0)?.hasProcess).toBe(false)
    expect(feed.replyAt(1)).toBeUndefined()
    expect(feed.replyAt(2)?.text).toBe('answer')
  })

  test('a contentless, timeless official run retains a static seal without a fake message', () => {
    const snapshot = snapshotOf([
      {
        kind: 'turn',
        turnId: 'empty',
        ordinal: 0,
        state: 'failed',
        origin: { kind: 'user' },
        steps: [],
      },
    ])
    const state = projectTranscript(snapshot)
    expect(allItems(state)).toEqual([])
    expect(state.spans).toEqual([{ turn: 0 }])
    const feed = selectPresentation(state, new Map())
    expect(feed.count).toBe(1)
    expect(feed.rowAt(0)?.item.type).toBe('run_anchor')
    expect(feed.sealAt(0)?.hasProcess).toBe(false)
    expect(feed.replyAt(0)).toBeUndefined()
  })

  test('invalid timing is absent rather than converted into zero', () => {
    const state = projectTranscript(
      snapshotOf([
        {
          ...runSample(0),
          startedAt: 'invalid',
          endedAt: 'invalid',
          durationMs: -1,
        },
      ]),
    )
    expect(state.spans).toEqual([{ turn: 0 }])
    const zero = projectTranscript(snapshotOf([{ ...runSample(0), durationMs: 0 }]))
    expect(zero.spans[0]?.durationMs).toBe(0)
  })

  test('official cold reconstruction and live operations retain the same visible meaning', () => {
    const base = groupMessagesIntoSnapshot([
      {
        id: 'prompt',
        role: 'user',
        origin: { kind: 'user' },
        content: [{ type: 'text', text: 'question' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'checking' }],
        toolCalls: [{ id: 'call', name: 'Read', arguments: JSON.stringify({ path: 'a.ts' }) }],
      },
      { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: 'result' }] },
    ])
    const cold = foldWireRecordFacts(
      [
        { type: 'turn.prompt', promptId: 'prompt', origin: { kind: 'user' }, time: 1000 },
        {
          type: 'turn.ended',
          turnId: 0,
          reason: 'failed',
          error: { message: 'boom' },
          durationMs: 2500,
          time: 3500,
        },
      ],
      base,
    )
    const live = new AgentTranscript('main')
    for (const item of cold.items) {
      if (item.kind !== 'turn') {
        continue
      }
      const { steps, ...header } = item
      live.receive([
        { op: 'turn.upsert', turn: { ...header, startedAt: new Date(1000).toISOString() } },
      ])
      for (const step of steps) {
        const { frames, ...stepHeader } = step
        live.receive([{ op: 'step.upsert', turnId: item.turnId, step: stepHeader }])
        for (const frame of frames) {
          live.receive([
            {
              op: 'frame.upsert',
              turnId: item.turnId,
              stepId: step.stepId,
              frame:
                frame.kind === 'tool'
                  ? {
                      ...frame,
                      display: { kind: 'file_io', operation: 'read', path: '/repo/a.ts' },
                    }
                  : frame,
            },
          ])
        }
      }
    }
    const restored = new AgentTranscript('main')
    restored.receive([{ op: 'reset', agentId: 'main', snapshot: cold }])
    const meaning = (snapshot: AgentTranscriptSnapshot, open: boolean) => {
      const feed = selectPresentation(projectTranscript(snapshot), new Map([[0, open]]))
      return Array.from({ length: feed.count }, (_, index) => {
        const item = feed.rowAt(index)?.item
        return {
          type: item?.type,
          kind: item?.type === 'tool_call' ? item.kind : undefined,
          subject: item?.type === 'tool_call' ? item.subject : undefined,
          process: feed.sealAt(index)?.hasProcess,
          duration: feed.sealAt(index)?.durationMs,
          reply: feed.replyAt(index)?.text,
        }
      })
    }
    for (const open of [false, true]) {
      expect(meaning(restored.snapshot(), open)).toEqual(meaning(live.snapshot(), open))
    }
    expect(projectTranscript(restored.snapshot()).status).toBe('failed')
  })
})
