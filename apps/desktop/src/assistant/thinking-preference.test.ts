import { describe, expect, it } from 'bun:test'
import type { SessionConfigControl } from '@poietica/agent-contract'
import { createThinkingPreferenceFromStorage } from './thinking-preference'

function controls(
  model: string,
  current: string,
  values: readonly string[],
): readonly SessionConfigControl[] {
  return [
    {
      id: 'model',
      label: 'Model',
      purpose: 'model',
      current: model,
      choices: [{ value: model, label: model }],
    },
    {
      id: 'thinking',
      label: 'Thinking',
      purpose: 'thought',
      current,
      choices: values.map((value) => ({ value, label: value })),
    },
  ]
}

describe('Thinking preference', () => {
  it('restores an accepted value for the same agent and model', () => {
    let held: Readonly<Record<string, string>> = {}
    const preference = createThinkingPreferenceFromStorage({
      read: () => held,
      write: (next) => {
        held = next
      },
    })

    preference.remember(
      'kimi',
      controls('deepseek', 'max', ['off', 'high', 'max']),
      'thinking',
      'max',
    )

    expect(
      preference.selection('kimi', controls('deepseek', 'high', ['off', 'high', 'max']))?.value,
    ).toBe('max')
  })

  it('does not leak across models or select a value the model no longer offers', () => {
    let held: Readonly<Record<string, string>> = {}
    const preference = createThinkingPreferenceFromStorage({
      read: () => held,
      write: (next) => {
        held = next
      },
    })

    preference.remember('kimi', controls('deepseek', 'max', ['high', 'max']), 'thinking', 'max')

    expect(
      preference.selection('kimi', controls('kimi-k2', 'high', ['high', 'max'])),
    ).toBeUndefined()
    expect(
      preference.selection('kimi', controls('deepseek', 'high', ['off', 'high'])),
    ).toBeUndefined()
  })
})
