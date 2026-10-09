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

/**
 * SettingsPort 需要的东西：root 设置、logger，以及**模型目录**。
 *
 * 模型目录是给现算选项表用的那一格：`sharpshooter.model` 的取值是「模型目录里的某一条」，
 * 而上游的 schema 只给了 string，选项要现算（legacy 的 `SettingChoicesOf` 同此）。
 * 自己写一份「有钥匙的 provider 的模型」就是第二个事实，与 `models` 端口那边必然分叉 ——
 * 所以这里收的是**同一个 RegistryPort**。
 */
export interface SettingsPortDeps {
  readonly root: SettingsScope
  readonly logger: Logger
  /** 模型目录（与 ModelsPort 同一个 registry），只为 sharpshooter.model 的选项表而来 */
  readonly registry?: RegistryPort | undefined
}

/**
 * 设置端口。catalog() 只列产品开放的键（清单在 settings-catalog.ts），写只落 root 的 global 层。
 * 会话的 overlay 读取实时穿透到 root，所以写完之后每条会话自动看到新值，不需要逐个通知。
 */
export class OmpSettingsPort implements SettingsPort {
  readonly #change = new Emitter<{ readonly paths: readonly string[] }>()
  readonly onDidChange = this.#change.event
  /**
   * 设置页分组次序（见 engine 的 SettingsPort.groupOrder 注释）。
   *
   * 交回的是 omp 自己的 **group 原文**（`Prompt` / `Mnemopi`…），次序取它们在
   * `orderedSettings()` 里的**首次出现**—— 那正是 omp 自己设置面板的排列
   * （域次序 + 域内声明次序），也是 legacy `catalog-rows` 的 `groupBy` 用的那份。
   *
   * **不是** pi-tui 的 `TAB_GROUPS`：那张表是终端面板的分节排列，与域的声明次序不同
   * （实测：记忆栏 TAB_GROUPS 把 Sharpshooter 排在最后，而 orderedSettings 把它排在
   * `mnemopi.*` 之前）。两者都「有来源」，但界面要与 legacy 一致，只能取后者。
   *
   * 键必须与 descriptor 的 `group` 同源（都是 omp 原文）：界面按那个键归并，
   * 换成译名会让两条不同的键撞上同一个名字。
   */
  readonly groupOrder: readonly string[]

  constructor(private readonly d: SettingsPortDeps) {
    this.groupOrder = groupOrderOf()
  }

  /**
   * 产品开放的设置键：类型、选项、默认值、条件从 omp 读，标签与说明取中文（查不到回退英文）。
   *
   * 次序取 `orderedSettings()`（omp 自己设置面板的排列：域次序 + 域内声明次序），
   * 而不是 `all()` 的注册次序 —— 后者是「谁先被 import」，同一节会碎成好几段。
   */
  async catalog(): Promise<z.infer<typeof SettingDescriptor>[]> {
    try {
      /*
       * 现算的选项表先算一次，整份目录共用：`sharpshooter.model` 那一格的取值来自模型目录，
       * 逐格重算就是把同一个目录读 N 遍。
       */
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
   * `sharpshooter.model` 的选项表：**此刻配好的那些模型**，外加「自动」。
   *
   * 这一格在 schema 里只是 string，上游不给选项（它自己的 TUI 用模型浏览器现选），所以选项
   * 必须在这里算。用的是与 `models` 端口**同一个 registry**：自己写一份「有钥匙的 provider
   * 的模型」就是第二个事实，两边必然分叉。
   *
   * 「自动」那一档的值是**空串**，不是 null：这一格留空 = 用 smol 角色（omp 的
   * `resolveSharpshooterModel` 先读这一格、读不到才回退 smol）。写回 agent 的也必须是空串
   * —— 那是它自己的「没配」表示（design-system 的 Select 为此专门不吞空串）。
   */
  #modelChoices(): readonly { value: string; label: string; description: null }[] {
    const registry = this.d.registry
    if (registry === undefined) return []
    /*
     * `available()` 已经是「有凭据、且过 enabledModels 白名单」的那一份（与模型选择器
     * 那一排同源）。读不出来就退回空表：宁可下拉里只有「自动」，也不要报一个假清单。
     */
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

  /** 一格目录项。字段与 legacy 的 AgentSettingEntry 对齐，见 engine 的 SettingDescriptor 注释。 */
  #descriptorOf(
    id: string,
    meta: SettingUiMetadata,
    modelChoices: readonly SettingOptionValue[],
  ): z.infer<typeof SettingDescriptor> {
    /*
     * 凭据类设置的 value 一律 null：值出了 agent 的进程就不再是我们的盘。
     * 读是必须的（不读就不知道配没配），但**读到的那一份绝不进结果** ——
     * 值直接折成一个布尔交给 hasValue，中间不落任何会被序列化出去的格。
     */
    const credential = isCredentialSetting(id)
    const configured = credential ? isConfiguredSetting(this.d.root, id) : false

    return {
      path: id,
      /*
       * `group` 是 **omp 自己的分节键**（`Prompt` / `Mnemopi`…）：界面按它建分组，
       * 换成中文会把两节合成一格，而屏幕上看不出哪里错了。给人看的那一列是 groupLabel。
       */
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
      /* 产品别处已有控件的格子：值照报，行不画（判据是「产品里已经有一处能改它」）。 */
      owned: ownedElsewhereOf(id),
      /* 归哪一页：「记忆」按 omp 的 tab 判，「个性化」按 path 名单判。 */
      section: sectionOf(id, meta.tab),
      secret: credential,
      hasValue: configured,
    }
  }

  /** 写一格：path 必须在产品开放的清单里，否则抛 kernel.invalid_params。 */
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

  /** 回到默认：从 global 层删掉这一格，别的层仍然生效。 */
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

  /**
   * 能力开关：写的是持久层（设置页上的开关，关掉再开一次之后必须还在），并让新值立刻被
   * 下一次工具调用看到。omp 官方的 /computer 用会话级 override 是因为它是会话内临时开关；
   * 我们这一格是设置页的持久控件，所以走 global 层。
   */
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

  /** Python 解释器：写 python.interpreter；传 null 时 unset（回到自动探测）。 */
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

  /** 读回当前解释器设置（07 页 §13C：pythons 的 onReady 判据读它）。写与读都只碰这一个键。 */
  async getPythonInterpreter(): Promise<string | null> {
    try {
      const value = readSetting(this.d.root, 'python.interpreter')
      return typeof value === 'string' && value.length > 0 ? value : null
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 端口释放（AgentEngine.dispose 时一并释放监听器）。 */
  dispose(): void {
    this.#change.dispose()
  }

  /** 只写产品开放的键：不在清单里的路径如实拒绝，不静默写进去。 */
  #requireProductSetting(path: string): void {
    const type = settingTypeOf(path)
    if (!isProductSetting(path, type)) {
      throw new AppError(SystemErrorCode.invalidParams, `这不是产品开放的设置：${path}`)
    }
  }
}

/**
 * 选项表：`value` 一格不译（写回 agent 的就是它），只换给人看的那一列。
 *
 * 认不出的格子由 `optionLabelOf` 原样交回上游 label；`description` 原样带上 ——
 * 界面只画 label（下拉每一行塞长句会把清单撑成一堆半截话），但那一格不该在我们这层丢掉。
 */
function optionsOf(
  id: string,
  raw: readonly SettingOptionRaw[] | undefined,
  modelChoices: readonly SettingOptionValue[],
): z.infer<typeof SettingDescriptor>['options'] {
  /*
   * schema 给得出就用它那一份；给不出（`'runtime'` / 干脆没有）才用现算的。
   * `sharpshooter.model` 是后者里唯一进产品目录的一格（见 modelSelectorSettingOf）。
   */
  if (raw === undefined) {
    return modelSelectorSettingOf(id) && modelChoices.length > 0 ? [...modelChoices] : null
  }
  return raw.map((option) => ({
    value: option.value,
    label: optionLabelOf(id, option.value, option.label),
    description: option.description ?? null,
  }))
}

/** 现算选项表的元素形状（与 SettingDescriptor.options 的元素同形，不另立一张表）。 */
type SettingOptionValue = NonNullable<z.infer<typeof SettingDescriptor>['options']>[number]

/** 契约的四档之外，omp 还有 array / record：那两类已经在上游被挡掉，这里只做类型收窄。 */
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
 * 目录的形状：进得了产品目录的那些格子的 id、分节键与栏，按 omp 自己设置面板的次序。
 *
 * 用 `orderedSettings()` 而不是 `all()`：后者是注册次序（谁先被 import），
 * 同一节会被拆散、节的先后也与面板不符。次序**进了界面**（分组按首次出现排），
 * 所以这一行不是风格问题。
 *
 * 三条判据在这里各走一遍，结果不收成第二张表：顺序、分节次序、每一格的归属都从
 * 同一份序列现算 —— 抄一份出来就有两个事实，而它们必然分叉。
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

/** 分节的次序：各 group 在面板序列里的**首次出现**（legacy `catalog-rows` 的 `groupBy` 同此）。 */
function groupOrderOf(): readonly string[] {
  return [...new Set(catalogRows().map((row) => row.group))]
}
