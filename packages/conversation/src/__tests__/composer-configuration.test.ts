import { describe, expect, it } from 'bun:test'
import type { SessionConfigControl } from '../agent/config'
import { canSubmitDraft } from '../composer/prompt'
import { activePromptConfiguration } from '../surface/composer/composer-actions'
import { sessionControlRows } from '../surface/composer/controls'
import { swarmControlOf } from '../surface/composer/swarm-toggle'

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
  it('keeps permission and swarm out of the settings menu', () => {
    const model: SessionConfigControl = {
      id: 'model',
      label: 'Model',
      purpose: 'model',
      current: 'k3',
      choices: [{ value: 'k3', label: 'K3' }],
    }
    const thinking = control('thinking', 'thought', 'medium')
    const permission = control('permission', 'permission', 'off')
    const swarm = control('swarm', 'other', 'off')

    /* 批准方式是工具条上常显的胶囊，Swarm 是上下文栏右端的勾选（swarm-toggle）。 */
    expect(sessionControlRows([permission, swarm, model, thinking]).map((item) => item.id)).toEqual(
      ['model', 'thinking'],
    )
    expect(swarmControlOf([model, swarm])).toBe(swarm)
    expect(swarmControlOf([model])).toBeUndefined()
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
