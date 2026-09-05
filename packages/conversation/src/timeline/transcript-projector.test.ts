import { describe, expect, test } from 'bun:test'
import { projectTranscript } from './transcript-projector'

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
