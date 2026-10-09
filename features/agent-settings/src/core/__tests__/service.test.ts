import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import type { SettingDescriptor } from '../../contract'
import { createAgentSettingsService, groupOf, validateValue } from '../service'

const option = (value: string, label = value) => ({ value, label, description: null })

const descriptor = (over: Partial<SettingDescriptor>): SettingDescriptor => ({
  path: 'x.y',
  group: 'General',
  groupLabel: '通用',
  label: 'X',
  description: '',
  type: 'boolean',
  options: null,
  value: null,
  defaultValue: null,
  warning: null,
  condition: null,
  owned: false,
  section: null,
  secret: false,
  hasValue: false,
  ...over,
})

function make(catalog: SettingDescriptor[]) {
  let current = catalog
  const calls: { op: string; path: string; value?: unknown }[] = []
  const service = createAgentSettingsService({
    settings: {
      groupOrder: [],
      async catalog() {
        return current
      },
      async set(path, value) {
        calls.push({ op: 'set', path, value })
        current = current.map((s) => (s.path === path ? { ...s, value } : s))
      },
      async reset(path) {
        calls.push({ op: 'reset', path })
        current = current.map((s) => (s.path === path ? { ...s, value: s.defaultValue } : s))
      },
      async capabilities() {
        return { computerUse: false, browserControl: false }
      },
      async setCapability(name, enabled) {
        calls.push({ op: 'cap', path: name, value: enabled })
      },
      async getPythonInterpreter() {
        return null
      },
      async setPythonInterpreter() {},
      onDidChange: () => ({ dispose: () => undefined }),
    },
    groupOrder: [],
    emitChanged: () => undefined,
  })
  return { service, calls }
}

describe('agent-settings 类型校验（14 页 §7.3）', () => {
  test('boolean 只收布尔', () => {
    const d = descriptor({ type: 'boolean' })
    expect(validateValue(d, true)).toBe(true)
    expect(validateValue(d, 'true')).toBe(false)
  })

  test('number 只收有限数', () => {
    const d = descriptor({ type: 'number' })
    expect(validateValue(d, 1)).toBe(true)
    expect(validateValue(d, Number.NaN)).toBe(false)
    expect(validateValue(d, Number.POSITIVE_INFINITY)).toBe(false)
    expect(validateValue(d, '1')).toBe(false)
  })

  test('enum 必须在 options 里', () => {
    const d = descriptor({ type: 'enum', options: [option('a'), option('b')] })
    expect(validateValue(d, 'a')).toBe(true)
    expect(validateValue(d, 'c')).toBe(false)
    /*
     * label 是给人看的那一列，**不是取值**：拿它判会把合法值全判成越界
     * （「关闭」不是写回 agent 的那个标识符）。
     */
    expect(validateValue(descriptor({ type: 'enum', options: [option('x', '关闭')] }), '关闭')).toBe(false)
    expect(validateValue(d, 1)).toBe(false)
  })

  test('string 只收字符串', () => {
    const d = descriptor({ type: 'string' })
    expect(validateValue(d, 'x')).toBe(true)
    expect(validateValue(d, 1)).toBe(false)
  })
})

describe('agent-settings 服务（14 页 §7.4）', () => {
  test('set 未知路径 → agent-settings.unknown_setting', async () => {
    const { service, calls } = make([descriptor({ path: 'a', type: 'number' })])
    const err = await service.set('not.exist', 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('agent-settings.unknown_setting')
    expect(calls).toEqual([])
  })

  test("boolean 设置传 'true'（字符串）→ agent-settings.invalid_value，且没写到引擎", async () => {
    const { service, calls } = make([descriptor({ path: 'a', type: 'boolean' })])
    const err = await service.set('a', 'true').catch((e: unknown) => e)
    expect((err as AppError).code).toBe('agent-settings.invalid_value')
    expect(calls).toEqual([])
  })

  test('enum 越界 → invalid_value', async () => {
    const { service } = make([descriptor({ path: 'a', type: 'enum', options: [option('x')] })])
    const err = await service.set('a', 'y').catch((e: unknown) => e)
    expect((err as AppError).code).toBe('agent-settings.invalid_value')
  })

  test('合法写入返回最新 descriptor，value 已更新', async () => {
    const { service } = make([descriptor({ path: 'a', type: 'number', value: 1 })])
    const after = await service.set('a', 5)
    expect(after.path).toBe('a')
    expect(after.value).toBe(5)
  })

  test('reset 未知路径也拒', async () => {
    const { service } = make([])
    const err = await service.reset('nope').catch((e: unknown) => e)
    expect((err as AppError).code).toBe('agent-settings.unknown_setting')
  })

  test('reset 合法路径回到默认值', async () => {
    const { service } = make([descriptor({ path: 'a', type: 'number', value: 9, defaultValue: 1 })])
    expect((await service.reset('a')).value).toBe(1)
  })

  test('capabilities 与 setCapability 转发', async () => {
    const { service, calls } = make([])
    expect(await service.capabilities()).toEqual({ computerUse: false, browserControl: false })
    await service.setCapability('computerUse', true)
    expect(calls).toEqual([{ op: 'cap', path: 'computerUse', value: true }])
  })
})

describe('catalog 分组（07 页 §7C）', () => {
  test('按 group 键归并，次序取 groupOrder，表外的组排在后面', () => {
    const groups = groupOf(
      [
        descriptor({ path: 'a', group: 'B' }),
        descriptor({ path: 'b', group: 'A' }),
        descriptor({ path: 'c', group: 'B' }),
        descriptor({ path: 'd', group: 'Z' }),
      ],
      ['A', 'B'],
    )
    expect(groups.map((g) => g.id)).toEqual(['A', 'B', 'Z'])
    expect(groups[1]!.settings.map((s) => s.path)).toEqual(['a', 'c'])
  })

  /*
   * 归并认 **group 键**，标题取 groupLabel：两者不是一件事。
   *
   * 拿译名当键会让两条不同的键撞上同一个名字（认不出的节原样交回英文，于是
   * `Sharpshooter` 与某个真叫「Sharpshooter」的中文译名会合成一格），
   * 而屏幕上看不出哪里错了 —— 正是这次修掉的那类缺陷。
   */
  test('标题取 groupLabel，归并仍按 group 键', () => {
    const groups = groupOf(
      [
        descriptor({ path: 'a', group: 'Mnemopi', groupLabel: 'Mnemopi' }),
        descriptor({ path: 'b', group: 'Thinking', groupLabel: '思考' }),
      ],
      ['Thinking', 'Mnemopi'],
    )
    expect(groups.map((g) => g.id)).toEqual(['Thinking', 'Mnemopi'])
    expect(groups.map((g) => g.label)).toEqual(['思考', 'Mnemopi'])
    /* 次序取的是 groupOrder 的键，不是译名的字典序。 */
    expect(groups[1]!.settings.map((s) => s.path)).toEqual(['a'])
  })
})
