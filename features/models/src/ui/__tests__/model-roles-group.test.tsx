import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ModelRoleInfo } from '../../contract'
import type { ModelsApi } from '../api'
import { ModelRolesGroup, optionsOf, unsetLabelOf } from '../model-roles-group'

/*
 * U-3：默认模型在上，其余角色收进「按用途指定」。没配的格写实际去向（跟随默认 / 跟随当前对话 / 自动（某模型）），
 * 没候选又没配过的格不画，折叠条只数配过的。
 */

const models = [
  { selector: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { selector: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

const role = (id: string, name: string, extra: Partial<ModelRoleInfo> = {}): ModelRoleInfo => ({
  role: id,
  name,
  description: null,
  section: 'chat',
  selector: null,
  candidates: models,
  fallback: { kind: 'role', role: 'default' },
  ...extra,
})

const ROLES: ModelRoleInfo[] = [
  role('default', '默认', { selector: 'anthropic/claude-sonnet-4-5' }),
  role('smol', '快速', { selector: 'anthropic/claude-haiku-4-5' }),
  role('tiny', '微型', { fallback: { kind: 'role', role: 'smol' } }),
  role('task', '子任务', { fallback: { kind: 'conversation' } }),
  role('image', '图像生成', { section: 'kind', candidates: [], fallback: { kind: 'auto', model: null } }),
  role('web', '联网搜索', { section: 'kind', fallback: { kind: 'auto', model: 'Exa' } }),
]

const nameOf = (id: string) => ROLES.find((r) => r.role === id)?.name ?? id

function fakeApi(roles: ModelRoleInfo[]) {
  const setRole = mock(async (_role: string, _selector: string | null) => undefined)
  const api = { roles: async () => roles, setRole, onChanged: () => ({ dispose: () => undefined }) }
  return { api: api as unknown as ModelsApi, setRole }
}

afterEach(cleanup)

describe('ModelRolesGroup', () => {
  test('默认模型单独一行；其余收起，折叠条只数配过的', async () => {
    render(<ModelRolesGroup api={fakeApi(ROLES).api} />)
    await screen.findByText('默认模型')
    expect(screen.getByRole('combobox', { name: '默认模型' }).textContent).toContain('Claude Sonnet 4.5')
    expect(screen.getByText('已指定 1 项')).toBeTruthy()
    expect(screen.queryByText('微型')).toBeNull()
  })

  test('展开后分「对话与任务」「专用能力」两组，没候选又没配的格不画', async () => {
    render(<ModelRolesGroup api={fakeApi(ROLES).api} />)
    fireEvent.click(await screen.findByRole('button', { name: /按用途指定/ }))
    await waitFor(() => expect(screen.getByRole('region', { name: '对话与任务' })).toBeTruthy())
    expect(screen.getByRole('region', { name: '专用能力' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '微型' }).textContent).toContain('跟随快速')
    expect(screen.getByRole('combobox', { name: '子任务' }).textContent).toContain('跟随当前对话')
    expect(screen.getByRole('combobox', { name: '联网搜索' }).textContent).toContain('自动（Exa）')
    expect(screen.queryByText('图像生成')).toBeNull()
  })

  test('没有任何模型时，默认模型一行只给去处', async () => {
    render(<ModelRolesGroup api={fakeApi([role('default', '默认', { candidates: [] })]).api} />)
    await screen.findByText('还没有可用的模型，先在「模型」页添加服务商')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText('按用途指定')).toBeNull()
  })
})

describe('选项与文案', () => {
  test('没配时的字照实际去向写', () => {
    expect(unsetLabelOf(role('smol', '快速'), nameOf)).toBe('跟随默认')
    expect(unsetLabelOf(role('x', 'x', { fallback: { kind: 'auto', model: null } }), nameOf)).toBe('自动选择')
  })

  test('当前值带思考档时顶替同一模型；@角色写成「跟随」；认不出的标不可用', () => {
    const high = optionsOf(role('slow', '深度思考', { selector: 'anthropic/claude-sonnet-4-5:high' }), nameOf)
    expect(high).toHaveLength(2)
    expect(high[0]).toEqual({ value: 'anthropic/claude-sonnet-4-5:high', label: 'Claude Sonnet 4.5' })
    expect(optionsOf(role('commit', '提交', { selector: '@smol' }), nameOf)[0]?.label).toBe('跟随快速')
    expect(optionsOf(role('commit', '提交', { selector: 'openai/gpt-4o' }), nameOf)[0]?.label).toBe(
      'openai/gpt-4o（不可用）',
    )
  })
})
