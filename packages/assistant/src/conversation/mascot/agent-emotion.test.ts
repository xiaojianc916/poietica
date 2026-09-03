import { describe, expect, test } from 'bun:test'
import type { TimelineState } from '@poietica/conversation'
import { type AgentEmotionId, agentEmotionId } from './agent-emotion'

const OUTPUT = {
  at: 1,
  id: 'agent-text',
  sealed: false,
  text: 'answer',
  turn: 0,
  type: 'agent_text',
} satisfies TimelineState['active']['items'][number]

const COMPACTION = {
  agentId: 'main',
  at: 1,
  id: 'compaction',
  state: 'running',
  turn: 0,
  type: 'compaction',
} satisfies TimelineState['active']['items'][number]

function tool(kind: 'search' | 'write') {
  return {
    at: 1,
    channels: [],
    content: [],
    id: `tool-${kind}`,
    kind,
    locations: [],
    requestContent: [],
    startedAt: 1,
    status: 'in_progress',
    subject: kind,
    title: kind,
    toolCallId: `tool-${kind}`,
    turn: 0,
    type: 'tool_call',
  } satisfies TimelineState['active']['items'][number]
}

function timeline(
  status: TimelineState['status'],
  items: TimelineState['active']['items'] = [],
): TimelineState {
  return {
    active: { items, turn: 0 },
    backgroundTasks: [],
    lastSeq: 0,
    sealed: [],
    spans: [],
    status,
  }
}

describe('agentEmotionId', () => {
  test('covers every upstream agent state from the transcript truth', () => {
    const cases: readonly {
      expected: AgentEmotionId
      restoring?: boolean
      state: TimelineState
    }[] = [
      { expected: '30', state: timeline('running') },
      { expected: '31', state: timeline('submitted') },
      { expected: '32', state: timeline('running', [tool('write')]) },
      { expected: '33', state: timeline('completed') },
      { expected: '34', state: timeline('failed') },
      { expected: '35', state: timeline('awaiting_question') },
      { expected: '36', restoring: true, state: timeline('idle') },
      { expected: '37', state: timeline('running', [COMPACTION]) },
      { expected: '38', state: timeline('awaiting_permission') },
      { expected: '39', state: timeline('running', [OUTPUT]) },
      { expected: '40', state: timeline('running', [tool('search')]) },
      { expected: '41', state: timeline('cancelled') },
    ]

    for (const current of cases) {
      expect(agentEmotionId(current.state, current.restoring ?? false)).toBe(current.expected)
    }
  })

  test('uses the newest live activity inside a running turn', () => {
    expect(agentEmotionId(timeline('running', [tool('search'), OUTPUT]), false)).toBe('39')
    expect(agentEmotionId(timeline('running', [OUTPUT, COMPACTION]), false)).toBe('37')
  })
})
