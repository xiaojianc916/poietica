import { describe, expect, it } from 'bun:test'
import type { SessionConfigControl } from '../../agent'
import { projectVisibleModelChoices } from '../model-choice-visibility'

const CONTROL: SessionConfigControl = {
  id: 'model',
  label: 'Model',
  purpose: 'model',
  current: 'provider/current',
  choices: [
    { value: 'provider/current', label: 'Current' },
    { value: 'provider/other', label: 'Other' },
  ],
}

describe('projectVisibleModelChoices', () => {
  it('hides configured aliases without mutating the agent table', () => {
    const source = [CONTROL]
    const result = projectVisibleModelChoices(source, ['provider/other'])
    expect(result).not.toBe(source)
    expect(result[0]?.choices.map((choice) => choice.value)).toEqual(['provider/current'])
    expect(CONTROL.choices).toHaveLength(2)
  })

  it('keeps the active alias to avoid silently switching a running session', () => {
    const result = projectVisibleModelChoices([CONTROL], ['provider/current'])
    expect(result[0]?.choices.map((choice) => choice.value)).toEqual([
      'provider/current',
      'provider/other',
    ])
  })
})
