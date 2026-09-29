import { describe, expect, it } from 'bun:test'
import type { SessionConfigControl } from '../agent/config'
import { canSubmitDraft } from '../composer/prompt'
import {
  activePromptConfiguration,
  composerPaletteGroups,
} from '../surface/composer/composer-actions'
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

/* 面板里模式那一组只有一行一行：拿一个控件问它画成什么样。 */
function modeRow(
  source: SessionConfigControl,
  onSelect: (controlId: string, value: string, input?: string) => void = () => undefined,
) {
  const group = composerPaletteGroups({
    controls: [source],
    mcpServers: [],
    onSelectControl: onSelect,
    skills: [],
  }).find((candidate) => candidate.id === 'modes')

  if (group === undefined) {
    throw new Error('the modes group must always exist')
  }

  return group.rows[0]!
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

  it('turns a prompt-bound mode into a draft configuration instead of a write', () => {
    const row = modeRow(control('goal', 'mode', 'off', true))

    /* 点的那一刻不发 set_config：正文还没写，当场发只能被 agent 拒。 */
    expect(row.action.kind).toBe('configure')
  })

  it('carries the draft text as the objective of a prompt-bound write', () => {
    const sent: [string, string, string | undefined][] = []
    const row = modeRow(control('plan', 'mode', 'off'), (id, value, input) => {
      sent.push([id, value, input])
    })

    expect(row.action.kind).toBe('run')

    /* run 收草稿正文：吞掉它，先打字再点「目标」也会被判成没有 objective。 */
    if (row.action.kind === 'run') {
      row.action.run('把发布做完')
    }

    expect(sent).toEqual([['plan', 'on', '把发布做完']])
  })
})
