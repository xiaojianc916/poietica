import { orderedSettings } from '@oh-my-pi/pi-coding-agent/config/all-settings'
import type { Capabilities, SettingDescriptor, SettingsPort } from '@poietica/engine'
import { AppError, Emitter, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { z } from 'zod'
import { toEngineError } from '../errors'
import {
  isConfiguredSetting,
  isCredentialSetting,
  readSetting,
  type SettingOptionRaw,
  type SettingsScope,
  type SettingUiMetadata,
  settingDefaultOf,
  settingUiOf,
  unsetGlobalSetting,
  writeGlobalSetting,
} from '../settings-access'
import { aliasOf, type OmpModelLike, type RegistryPort } from './model-helpers'
import {
  descriptionOf,
  groupLabelOf,
  isProductSetting,
  labelOf,
  modelSelectorSettingOf,
  optionLabelOf,
  ownedElsewhereOf,
  sectionOf,
} from './settings-catalog'
import { flushOf, settingTypeOf } from './settings-writes'

/** 能力开关背后是 omp 自己的两个设置项：桌面控制与浏览器控制。 */
const CAPABILITY_PATHS = {
  computerUse: 'computer.enabled',
  browserControl: 'browser.enabled',
} as const satisfies Readonly<Record<keyof z.infer<typeof Capabilities>, string>>

/** 能力开关的键（与契约的 Capabilities 同源）。 */
type CapabilityName = keyof z.infer<typeof Capabilities>

/** 收的是与 `models` 端口**同一个 RegistryPort**：`sharpshooter.model` 的选项要现算，自己写一份「有钥匙的 provider 的模型」就是第二个事实 */
export interface SettingsPortDeps {
  readonly root: SettingsScope
  readonly logger: Logger
  readonly registry?: RegistryPort | undefined
}

/** catalog() 只列产品开放的键（清单在 settings-catalog.ts），写只落 root 的 global 层；会话的 overlay 实时穿透到 root */
export class OmpSettingsPort implements SettingsPort {
  readonly #change = new Emitter<{ readonly paths: readonly string[] }>()
  readonly onDidChange = this.#change.event
  /**
   * 交回的是 omp 自己的 **group 原文**，次序取它们在 `orderedSettings()` 里的首次出现 —— 那正是 omp 设置面板
   * 的排列。**不是** pi-tui 的 `TAB_GROUPS`：那张表是终端面板的分节排列，与域的声明次序不同（实测：记忆栏
   * TAB_GROUPS 把 Sharpshooter 排在最后，而 orderedSettings 把它排在 `mnemopi.*` 之前）。键必须与 descriptor
   * 的 `group` 同源，换成译名会让两条不同的键撞上同一个名字。
   */
  readonly groupOrder: readonly string[]

  constructor(private readonly d: SettingsPortDeps) {
    this.groupOrder = groupOrderOf()
  }

  /** 类型、选项、默认值、条件从 omp 读，标签与说明取中文（查不到回退英文）；次序取 `orderedSettings()` 而不是 `all()` 的注册次序 */
  async catalog(): Promise<z.infer<typeof SettingDescriptor>[]> {
    try {
      /* 现算的选项表先算一次整份目录共用：逐格重算就是把同一个模型目录读 N 遍 */
      const modelChoices = this.#modelChoices()
      const out: z.infer<typeof SettingDescriptor>[] = []
      for (const row of catalogRows()) {
        out.push(this.#descriptorOf(row.id, settingUiOf(row.id), modelChoices))
      }
      return out
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /**
   * `sharpshooter.model` 的选项表：**此刻配好的那些模型**，外加「自动」。这一格在 schema 里只是 string，
   * 上游不给选项，所以必须在这里算（同 `models` 端口的 registry）。「自动」那一档的值是**空串**不是 null：
   * 这一格留空 = 用 smol 角色，写回 agent 的也必须是空串 —— 那是它自己的「没配」表示。
   */
  #modelChoices(): readonly { value: string; label: string; description: null }[] {
    const registry = this.d.registry
    if (registry === undefined) return []
    /* `available()` 已是「有凭据、且过 enabledModels 白名单」的那一份；读不出来就退回空表，不报假清单 */
    let models: readonly OmpModelLike[]
    try {
      models = registry.available()
    } catch (error) {
      this.d.logger.warn('model choices unavailable', { error: String(error) })
      return []
    }
    return [
      { value: '', label: '自动（使用 smol 角色）', description: null },
      ...models.map((model) => ({ value: aliasOf(model), label: model.name ?? model.id, description: null })),
    ]
  }

  #descriptorOf(
    id: string,
    meta: SettingUiMetadata,
    modelChoices: readonly SettingOptionValue[],
  ): z.infer<typeof SettingDescriptor> {
    /* 凭据类设置的 value 一律 null：读是必须的（不读就不知道配没配），但**读到的那一份绝不进结果**，只折成一个布尔 */
    const credential = isCredentialSetting(id)
    const configured = credential ? isConfiguredSetting(this.d.root, id) : false

    return {
      path: id,
      /* `group` 是 **omp 自己的分节键**：换成中文会把两节合成一格，而屏幕上看不出哪里错了 */
      group: meta.group ?? '',
      groupLabel: groupLabelOf(meta.group ?? ''),
      label: labelOf(id, meta.label),
      description: descriptionOf(id, meta.description ?? ''),
      type: descriptorTypeOf(id),
      options: optionsOf(id, meta.options, modelChoices),
      value: credential ? null : (readSetting(this.d.root, id) ?? null),
      defaultValue: settingDefaultOf(id) ?? null,
      warning: meta.warning ?? null,
      condition: meta.condition ?? null,
      owned: ownedElsewhereOf(id),
      section: sectionOf(id, meta.tab),
      secret: credential,
      hasValue: configured,
    }
  }

  async set(path: string, value: unknown): Promise<void> {
    try {
      this.#requireProductSetting(path)
      writeGlobalSetting(this.d.root, path, value)
      await flushOf(this.d.root)
      this.#change.fire({ paths: [path] })
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async reset(path: string): Promise<void> {
    try {
      this.#requireProductSetting(path)
      unsetGlobalSetting(this.d.root, path)
      await flushOf(this.d.root)
      this.#change.fire({ paths: [path] })
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async capabilities(): Promise<z.infer<typeof Capabilities>> {
    try {
      return {
        computerUse: readSetting(this.d.root, CAPABILITY_PATHS.computerUse) === true,
        browserControl: readSetting(this.d.root, CAPABILITY_PATHS.browserControl) === true,
      }
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 写的是持久层（设置页的开关，关掉再开一次之后必须还在），并让新值立刻被下一次工具调用看到；omp 官方的 /computer 是会话内临时开关，所以走 global 层 */
  async setCapability(name: CapabilityName, enabled: boolean): Promise<void> {
    try {
      const path: string = CAPABILITY_PATHS[name]
      writeGlobalSetting(this.d.root, path, enabled)
      await flushOf(this.d.root)
      this.d.logger.info('capability toggled', { name: String(name), enabled })
      this.#change.fire({ paths: [path] })
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async setPythonInterpreter(exePath: string | null): Promise<void> {
    try {
      const path = 'python.interpreter'
      if (exePath === null) unsetGlobalSetting(this.d.root, path)
      else writeGlobalSetting(this.d.root, path, exePath)
      await flushOf(this.d.root)
      this.#change.fire({ paths: [path] })
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async getPythonInterpreter(): Promise<string | null> {
    try {
      const value = readSetting(this.d.root, 'python.interpreter')
      return typeof value === 'string' && value.length > 0 ? value : null
    } catch (error) {
      throw toEngineError(error)
    }
  }

  dispose(): void {
    this.#change.dispose()
  }

  #requireProductSetting(path: string): void {
    const type = settingTypeOf(path)
    if (!isProductSetting(path, type)) {
      throw new AppError(SystemErrorCode.invalidParams, `这不是产品开放的设置：${path}`)
    }
  }
}

/** `value` 一格不译（写回 agent 的就是它），只换给人看的那一列；`description` 原样带上 —— 界面只画 label，但那一格不该在我们这层丢掉 */
function optionsOf(
  id: string,
  raw: readonly SettingOptionRaw[] | undefined,
  modelChoices: readonly SettingOptionValue[],
): z.infer<typeof SettingDescriptor>['options'] {
  /* schema 给得出就用它那一份；给不出（`'runtime'` / 干脆没有）才用现算的（只有 `sharpshooter.model` 进目录） */
  if (raw === undefined) {
    return modelSelectorSettingOf(id) && modelChoices.length > 0 ? [...modelChoices] : null
  }
  return raw.map((option) => ({
    value: option.value,
    label: optionLabelOf(id, option.value, option.label),
    description: option.description ?? null,
  }))
}

type SettingOptionValue = NonNullable<z.infer<typeof SettingDescriptor>['options']>[number]

function descriptorTypeOf(path: string): 'boolean' | 'enum' | 'number' | 'string' {
  const type = settingTypeOf(path)
  switch (type) {
    case 'boolean':
      return 'boolean'
    case 'enum':
      return 'enum'
    case 'number':
      return 'number'
    default:
      return 'string'
  }
}

/**
 * 进得了产品目录的那些格子的 id、分节键与栏，按 omp 自己设置面板的次序：用 `orderedSettings()` 而不是
 * `all()`（后者是注册次序，同一节会被拆散、节的先后也与面板不符）。次序**进了界面**，不是风格问题。
 * 三条判据都从同一份序列现算 —— 抄一份出来就有两个必然分叉的事实。
 */
function catalogRows(): readonly { readonly id: string; readonly group: string; readonly tab: string }[] {
  const rows: { id: string; group: string; tab: string }[] = []
  for (const setting of orderedSettings()) {
    const ui = setting.ui
    if (ui === undefined || ui.group === undefined) continue
    if (!isProductSetting(setting.id, settingTypeOf(setting.id))) continue
    rows.push({ id: setting.id, group: ui.group, tab: ui.tab })
  }
  return rows
}

/** 分节的次序：各 group 在面板序列里的**首次出现** */
function groupOrderOf(): readonly string[] {
  return [...new Set(catalogRows().map((row) => row.group))]
}
