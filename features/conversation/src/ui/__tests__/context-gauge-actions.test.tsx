import { afterEach, describe, expect, test } from 'bun:test'
import type { SlashCommand } from '@poietica/engine'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ContextGauge } from '../composer/view/context-gauge'
import type { SessionUsage } from '../shared/model/usage'

/* O-02：上下文面板底部的维护动作只是 omp 命令的快捷方式 —— 表里有才画，点下去交出的就是那句命令。 */

afterEach(cleanup)

const usage: SessionUsage = {
  used: 150_000,
  size: 200_000,
  inputOther: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
  breakdown: null,
}

const command = (name: string): SlashCommand => ({
  name,
  aliases: [],
  description: null,
  hint: null,
  source: 'builtin',
  subcommands: [],
})

function mount(commands: readonly SlashCommand[], busy = false) {
  const ran: string[] = []
  const view = render(
    <ContextGauge busy={busy} commands={commands} onRunCommand={(text) => ran.push(text)} usage={usage} />,
  )
  fireEvent.click(view.getByRole('button', { name: '上下文已用 75%' }))
  return { ran, view }
}

describe('上下文面板的维护动作', () => {
  test('只画命令表里有的那几条，点下去交出 /命令 并收起面板', () => {
    const { ran, view } = mount([command('compact'), command('handoff'), command('model')])
    expect(view.queryByRole('button', { name: '瘦身' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '压缩' }))
    expect(ran).toEqual(['/compact'])
    expect(view.queryByRole('dialog')).toBeNull()
  })

  test('一轮在跑时按钮灰掉', () => {
    const { view } = mount([command('shake')], true)
    expect((view.getByRole('button', { name: '瘦身' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('命令表里一条都没有就不画那一排', () => {
    const { view } = mount([command('model')])
    expect(view.getByRole('dialog').querySelector('.context-gauge__actions')).toBeNull()
  })
})
