import type { SettingsPort } from '@poietica/engine'
import { AppError } from '@poietica/foundation'
import type { Capabilities, SettingDescriptor, SettingGroup } from '../contract'
import { agentSettingsErrors } from '../contract/errors'

export interface AgentSettingsServiceDeps {
  readonly settings: SettingsPort
  /**
   * 分节次序：各 `group` 键在 omp 设置面板里的首次出现（07 页 §7C 的「分组顺序取自设置目录」）。
   *
   * 是**键**的序列，不是译名 —— descriptor 的 `group` 存的也是键，界面按它归并；
   * 换成译名会让两条不同的键撞上同一个名字，屏幕上看不出哪里错了。
   */
  readonly groupOrder: readonly string[]
  readonly emitChanged: (paths: readonly string[]) => void
}

export interface AgentSettingsService {
  catalog(): Promise<{ groups: SettingGroup[] }>
  set(path: string, value: unknown): Promise<SettingDescriptor>
  reset(path: string): Promise<SettingDescriptor>
  capabilities(): Promise<Capabilities>
  setCapability(name: keyof Capabilities, enabled: boolean): Promise<Capabilities>
}

/** 按 descriptor 的 type 校验（14 页 §7.3 的规则表）；不合法 → agent-settings.invalid_value */
export function validateValue(descriptor: SettingDescriptor, value: unknown): boolean {
  switch (descriptor.type) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      // descriptor 没有 min/max 字段（04 页 §2.2 的 schema）：只能要求有限数
      return typeof value === 'number' && Number.isFinite(value)
    case 'enum': {
      /* 选项的 `value` 才是取值：label 是给人看的那一列，拿它判会把合法值全判成越界。 */
      const options = descriptor.options ?? []
      return typeof value === 'string' && options.some((option) => option.value === value)
    }
    case 'string':
      return typeof value === 'string'
  }
}

/**
 * 把 descriptor 列表按 `group` 归并成分组。
 *
 * 分组的**键**是 omp 自己的分节键（`Prompt` / `Mnemopi`…），给人看的标题取 descriptor 的
 * `groupLabel` —— 归并只用键，译文只上屏。次序取 `groupOrder`（各键在 omp 面板里的首次出现），
 * 表外的组按首次出现排在后面。
 */
export function groupOf(settings: readonly SettingDescriptor[], groupOrder: readonly string[]): SettingGroup[] {
  const byId = new Map<string, SettingGroup>()
  for (const s of settings) {
    const existing = byId.get(s.group)
    if (existing === undefined) byId.set(s.group, { id: s.group, label: s.groupLabel, settings: [s] })
    else existing.settings.push(s)
  }
  const ordered: SettingGroup[] = []
  const taken = new Set<string>()
  for (const id of groupOrder) {
    const found = byId.get(id)
    if (found === undefined) continue
    ordered.push(found)
    taken.add(id)
  }
  for (const [id, group] of byId) if (!taken.has(id)) ordered.push(group)
  return ordered
}

export function createAgentSettingsService(d: AgentSettingsServiceDeps): AgentSettingsService {
  const find = async (path: string): Promise<SettingDescriptor> => {
    const descriptor = (await d.settings.catalog()).find((s) => s.path === path)
    if (descriptor === undefined) {
      throw new AppError(agentSettingsErrors.unknown_setting, '不是产品开放的设置项')
    }
    return descriptor
  }

  const latest = async (path: string): Promise<SettingDescriptor> => find(path)

  return {
    async catalog() {
      return { groups: groupOf(await d.settings.catalog(), d.groupOrder) }
    },
    async set(path, value) {
      // 校验在功能层做一次，引擎端口内部还会再校验一次 —— 有意的双重防线（14 页 §7.3）
      const descriptor = await find(path)
      if (!validateValue(descriptor, value)) {
        throw new AppError(agentSettingsErrors.invalid_value, '值不符合这一项的类型约束')
      }
      await d.settings.set(path, value)
      return latest(path)
    },
    async reset(path) {
      await find(path)
      await d.settings.reset(path)
      return latest(path)
    },
    capabilities: () => d.settings.capabilities(),
    async setCapability(name, enabled) {
      await d.settings.setCapability(name as 'computerUse' | 'browserControl', enabled)
      return d.settings.capabilities()
    },
  }
}
