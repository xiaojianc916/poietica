import { describe, expect, it } from 'bun:test'
import { sessionControlRows } from '@poietica/composer'
import type { SessionConfigControl } from '@poietica/conversation'
import { activePromptConfiguration } from '../composer/composer-actions'
import { canSubmitDraft } from '../composer/prompt-input'

function control(
  id: string,
  purpose: SessionConfigControl['purpose'],
  current: string,
  appliesOnSubmit = false,
): SessionConfigControl {
  return {
    id,
    label: id,
    purpose,
    current,
    choices: [
      { value: 'off', label: 'off' },
      { value: 'on', label: 'on' },
    ],
    ...(appliesOnSubmit ? { appliesOnSubmit: true as const } : {}),
  }
}

describe('composer configuration transaction', () => {
  it('does not expose permission in the model menu and keeps swarm independent', () => {
    const model: SessionConfigControl = {
      id: 'model',
      label: 'Model',
      purpose: 'model',
      current: 'k3',
      choices: [{ value: 'k3', label: 'K3' }],
    }
    const permission = control('permission', 'permission', 'off')
    const swarm = control('swarm', 'other', 'off')

    expect(sessionControlRows([permission, swarm, model]).map((item) => item.id)).toEqual([
      'model',
      'swarm',
    ])
  })

  it('carries active immediate modes without treating goal as already committed', () => {
    expect(
      activePromptConfiguration([
        control('plan', 'mode', 'on'),
        control('swarm', 'other', 'on'),
        control('goal', 'mode', 'on', true),
      ]),
    ).toEqual([
      { id: 'plan', value: 'on' },
      { id: 'swarm', value: 'on' },
    ])
  })

  it('requires real text when a prompt-bound goal is selected', () => {
    expect(canSubmitDraft({ hasText: false, hasFiles: true, requiresText: true })).toBe(false)
    expect(canSubmitDraft({ hasText: true, hasFiles: false, requiresText: true })).toBe(true)
  })
})
