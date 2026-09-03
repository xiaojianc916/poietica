import { describe, expect, it } from 'bun:test'
import { labelOf } from '@poietica/composer'
import type { SessionConfigControl } from '@poietica/conversation'

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
  it('title-cases offered Thinking values without manufacturing Default', () => {
    expect(THINKING.choices.map((choice) => labelOf(THINKING, choice))).toEqual([
      'Off',
      'High',
      'Max',
    ])
    expect(THINKING.choices.map((choice) => labelOf(THINKING, choice))).not.toContain('Default')
  })
})
