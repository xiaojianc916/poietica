import { describe, expect, test } from 'bun:test'
import { createFakeEngine } from '@poietica/engine-testkit'
import { AppError } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'
import type { SettingDescriptor } from '../../contract'
import { restoreSecretSettings, type SecretSettingsVault } from '../secret-settings'
import { createAgentSettingsService, groupOf, validateValue } from '../service'

function memoryVault(o: { failPut?: boolean } = {}): SecretSettingsVault & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    all: async () => Object.fromEntries(data),
    put: async (path, value) => {
      if (o.failPut === true) throw new AppError('secrets.unavailable', '系统的凭据加密不可用，密钥没有保存')
      data.set(path, value)
    },
    delete: async (path) => {
      data.delete(path)
    },
  }
}

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

function make(catalog: SettingDescriptor[], vault = memoryVault()) {
  let current = catalog
  const calls: { op: string; path: string; value?: unknown }[] = []
  const service = createAgentSettingsService({
    vault,
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
      async injectSecret(path, value) {
        calls.push({ op: 'inject', path, value })
        current = current.map((s) => (s.path === path ? { ...s, hasValue: value !== null } : s))
      },
      async storedSecrets() {
        return []
      },
      onDidChange: () => ({ dispose: () => undefined }),
    },
    groupOrder: [],
    emitChanged: () => undefined,
  })
  return { service, calls, vault }
}

describe('agent-settings 凭据类设置（ADR-008）', () => {
  const token = descriptor({ path: 'hindsight.apiToken', type: 'string', secret: true })

  test('set：值进凭据库、注入引擎覆盖层，不走持久层 set；reset / 空串：两边都撤', async () => {
    const { service, calls, vault } = make([token])
    expect((await service.set('hindsight.apiToken', 'tok-1')).hasValue).toBe(true)
    expect(vault.data.get('hindsight.apiToken')).toBe('tok-1')
    expect(calls).toEqual([{ op: 'inject', path: 'hindsight.apiToken', value: 'tok-1' }])
    expect((await service.reset('hindsight.apiToken')).hasValue).toBe(false)
    expect(vault.data.has('hindsight.apiToken')).toBe(false)
    await service.set('hindsight.apiToken', 'tok-2')
    await service.set('hindsight.apiToken', '')
    expect(vault.data.has('hindsight.apiToken')).toBe(false)
    expect(calls.some((c) => c.op === 'set')).toBe(false)
  })

  test('凭据库写不进去：set 失败，引擎没被注入', async () => {
    const { service, calls } = make([token], memoryVault({ failPut: true }))
    await expect(service.set('hindsight.apiToken', 'tok-1')).rejects.toMatchObject({ code: 'secrets.unavailable' })
    expect(calls).toEqual([])
  })

  test('启动：config.yml 里的旧明文搬进凭据库并删掉，凭据库的每一格注入引擎；搬不进的留在原处', async () => {
    const engine = createFakeEngine({ storedSecrets: [{ path: 'hindsight.apiToken', value: 'tok-legacy' }] })
    const vault = memoryVault()
    vault.data.set('searxng.token', 'tok-vault')
    const logger = createTestLogger()
    await restoreSecretSettings({ vault, settings: engine.settings, logger })
    expect(vault.data.get('hindsight.apiToken')).toBe('tok-legacy')
    expect(engine.injectedSecrets.get('hindsight.apiToken')).toBe('tok-legacy')
    expect(engine.injectedSecrets.get('searxng.token')).toBe('tok-vault')
    expect(JSON.stringify(logger.records)).not.toContain('tok-')

    const stuck = createFakeEngine({ storedSecrets: [{ path: 'hindsight.apiToken', value: 'tok-legacy' }] })
    await restoreSecretSettings({ vault: memoryVault({ failPut: true }), settings: stuck.settings, logger })
    expect(await stuck.settings.storedSecrets()).toEqual([{ path: 'hindsight.apiToken', value: 'tok-legacy' }])
    expect(stuck.injectedSecrets.size).toBe(0)
  })
})

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
    /* label 是给人看的那一列，**不是取值**：拿它判会把合法值全判成越界（「关闭」不是写回 agent 的那个标识符）。 */
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

  /* 归并认 **group 键**，标题取 groupLabel。拿译名当键会让两条不同的键撞上同一个名字（认不出的节原样交回英文），而屏幕上看不出哪里错了
   * —— 正是这次修掉的那类缺陷。 */
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
    expect(groups[1]!.settings.map((s) => s.path)).toEqual(['a'])
  })
})
