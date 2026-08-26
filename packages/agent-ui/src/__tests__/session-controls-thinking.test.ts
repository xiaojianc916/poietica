import { describe, expect, it } from 'bun:test'
import type { SessionConfigControl } from '@poietica/agent-contract'
import { hasUnavailableThinking, labelOf } from '../composer/session-controls'

const MODEL: SessionConfigControl = {
  id: 'model',
  label: 'Model',
  purpose: 'model',
  current: 'plain',
  choices: [{ value: 'plain', label: 'Plain' }],
}

const THINKING: SessionConfigControl = {
  id: 'thinking',
  label: 'Thinking',
  purpose: 'thought',
  current: 'high',
  choices: [
    { value: 'off', label: 'Thinking off' },
    { value: 'high', label: 'high' },
    { value: 'max', label: 'max' },
  ],
}

describe('Thinking availability projection', () => {
  it('shows the disabled no state only for a model without a Thought control', () => {
    expect(hasUnavailableThinking([MODEL])).toBe(true)
    expect(hasUnavailableThinking([MODEL, THINKING])).toBe(false)
    expect(hasUnavailableThinking([])).toBe(false)
  })

  it('title-cases offered Thinking values without manufacturing Default', () => {
    expect(THINKING.choices.map((choice) => labelOf(THINKING, choice))).toEqual([
      'Off',
      'High',
      'Max',
    ])
    expect(THINKING.choices.map((choice) => labelOf(THINKING, choice))).not.toContain('Default')
  })
})
