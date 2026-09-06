import { describe, expect, it } from 'bun:test'
import type { SessionConfigControl } from '../agent/config'
import { labelOf } from '../surface/composer/controls'

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
