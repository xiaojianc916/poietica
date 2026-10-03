/*
 * agent 自己那份设置目录的读法。
 *
 * 逐格从 omp 的设置注册表读出来，一格都不抄：`label` / `description` / 类型 /
 * 选项表都是它自报的（config/registry.ts 的 `Setting` 句柄：ui / type / default /
 * enumValues / isCredential），我们只负责画。抄一份就是第二个事实 —— 升级 omp
 * 时两份必然分叉（AGENTS.md §0）。
 *
 * 18.5.0 起上游把设置改成**注册**出来的：`SETTINGS_SCHEMA` / `getUi` / `getDefault` 那一套
 * 整支删掉，换成各域自己 `register()` + `config/all-settings.ts` 汇总。所以这一层要先
 * import all-settings（见下），否则注册表是空的 —— 目录会静默变成 0 格。
 *
 * 中文只有**给我们看的那一列**换成译文（settings-labels.ts）：`label` 换成中文，
 * 认不出的路径原文返回。`path` / `group` **一律是 omp 自己的标识符** —— 界面按
 * `entry.group` 建 Map 分组，换成中文就把两节合成一格，屏幕看不出哪里错了。
 *
 * 钥匙那三格（mnemopi.embeddingApiKey / mnemopi.llmApiKey / hindsight.apiToken）
 * **只有有没有值**这一件出得去：值本身出了 agent 的进程就不再是我们的盘。
 */

/* 副作用 import：设置是**注册**出来的（register 模式），这一支把每个域都加载一遍。
   没有它 registry 是空的 —— 目录会变成 0 格而不是报错。 */
import { orderedSettings } from '@oh-my-pi/pi-coding-agent/config/all-settings'
import { type AnySetting, lookup, type ScopeLike } from '@oh-my-pi/pi-coding-agent/config/registry'
import type { SettingEntry, SettingOption } from './protocol.ts'
import { settingDescriptionOf } from './settings-descriptions.ts'
import {
  groupLabelOf,
  irrelevantSettingOf,
  memorySettingOf,
  optionLabelOf,
  ownedElsewhereOf,
  personaSettingOf,
  settingLabelOf,
} from './settings-labels.ts'

/** 读设置的那一面：只有 `get`，写不在这里（写走调用方自己的持久层）。 */
export interface SettingsReader {
  get(key: string): unknown
}

/*
 * 按 **path** 寻址一格设置。
 *
 * 18.5.0 把设置改成注册表 + 类型化句柄（`Setting`）：`Settings.get(path)` / `set(path, v)` 那一对
 * 整支删掉，句柄才是官方门面。而本仓按 path 寻址是有意的 —— 目录要逐格走完上游那张表
 * （settings 命令把 path 当线上标识符交给界面），不可能为几百格各绑一个 import。
 *
 * 所以 `lookup` 是这里唯一的路径解析点：认不出的路径**如实报错**，不静默。
 * 从前 `Settings.get` 对认不出的路径也抛（它直接对空定义取 `.default`），语义照旧。
 */
function settingAt(path: string): AnySetting {
  const setting = lookup(path)

  if (setting === undefined) {
    throw new Error(`agent 那边没有叫这个名字的设置：${path}`)
  }

  return setting
}

/** 读一格：各层合并后的值，谁都没配就是它自己的默认（与老 `Settings.get` 同义）。 */
export function settingValueOf(scope: ScopeLike, path: string): unknown {
  return settingAt(path).get(scope)
}

/** 写一格：落全局层、后台保存（与老 `Settings.set` 同义）。 */
export function writeSettingValue(scope: ScopeLike, path: string, value: unknown): void {
  settingAt(path).set(scope, value)
}

/**
 * 全局那一档思考深度的**默认值**（不是用户配的那一格）。
 *
 * 建会话时上游先按 pickInitialThinkingLevel 选一档，随后本产品把会话收敛一次，收敛用的
 * 就是这个默认值 —— 所以它必须与会话侧同源（bridge.ts 的 settleThinking 与
 * expected-state.ts 的入口「此刻」都读这里）。
 */
export function globalThinkingDefault(): string | undefined {
  const value = lookup('defaultThinkingLevel')?.default

  return typeof value === 'string' ? value : undefined
}

/** 把真实设置实例接成目录要的那一面（`readCatalog` 的入参）。 */
export function settingsReaderOf(scope: ScopeLike): SettingsReader {
  return { get: (path) => lookup(path)?.get(scope) }
}

/*
 * 现算的选项表：schema 里给不出的那几格。
 *
 * 上游的 `ui.options` 有两种给不出选项的情形：`'runtime'`（选项由运行时层算，
 * 如主题表）与干脆没有（string 类型但取值有约束，如 `sharpshooter.model` 的
 * 「模型目录里的某一条」）。后者的选项只有**调用方**知道怎么算 —— 那是模型目录，
 * 住在桥里，不住在设置这一层。所以这里只留一个口子，判据（哪一格要现算）仍归
 * settings-labels.ts，两边不各写一份路径名单。
 */
export type SettingChoicesOf = (path: string) => readonly SettingOption[] | undefined

/**
 * 整份目录。
 *
 * 只有带 ui 元数据的那几格上屏：没有元数据的格子是内部件（`modelPattern*` 这类），
 * omp 自己的设置面板也不画它们 —— 画出来是我们替它做了一个它没做的决定。
 *
 * 两类格子仍然**报值但不上屏**（`owned` 标着）：一类跟这台桌面软件无关（终端渲染那些，
 * 见 `irrelevantSettingOf`），一类产品已经有专属控件管着（计划/目标/思考档位/审批/浏览器，
 * 见 `ownedElsewhereOf`）。它们必须留在目录里，因为别的格子按 `condition` 读它们的 value
 * 决定显不显示 —— 抽掉值，那几行会永远消失而没有迹象。
 */
export function readCatalog(
  settings: SettingsReader,
  choicesOf?: SettingChoicesOf,
): SettingEntry[] {
  const entries: SettingEntry[] = []

  for (const setting of orderedSettings()) {
    const ui = setting.ui

    if (ui === undefined) {
      continue
    }

    const path = setting.id

    /*
     * 跟这台桌面软件无关的格子**整格不报**。
     *
     * 边车是「omp 的 SDK 编进一个无界面进程」：终端渲染、CLI 子命令、启动向导、终端键盘
     * 与语音这些读取点在我们这条进程里根本跑不到。画出来就是骗人 —— 让人以为改了会变。
     * 判据与理由在 settings-labels.ts 的 irrelevantSettingOf。
     */
    if (irrelevantSettingOf(path, ui.group)) {
      continue
    }

    entries.push(entryOf(setting, settings, choicesOf))
  }

  return entries
}

function entryOf(
  setting: AnySetting,
  settings: SettingsReader,
  choicesOf: SettingChoicesOf | undefined,
): SettingEntry {
  const path = setting.id
  /* 调用方只把带 ui 的那几格交进来（readCatalog 的闸门），所以这里它一定在。 */
  const ui = setting.ui as NonNullable<AnySetting['ui']>
  /*
   * 钥匙那一格：只报有没有值。
   *
   * 读是必须的（不读就不知道配没配），但**读到的那一份绝不进结果**：值直接喂进
   * isConfigured 里折成一个布尔，中间不落任何会被序列化出去的格（AGENTS.md §1
   * 「密钥永不落我们的盘」）。这不是顺手写的一行，是这一层唯一的隐私边界。
   */
  const secret = setting.isCredential
  const value = settings.get(path)
  /* schema 给得出就用手册那一份，给不出（'runtime' / 没有）才问调用方现算的。 */
  const options = optionsOf(path, ui.options) ?? choicesOf?.(path)
  // 有 options 就不再报 enumValues：两张表说的是同一件事，报两份会让界面挑花眼。
  const enumValues = options === undefined ? setting.enumValues : undefined

  return {
    path,
    type: setting.type,
    /* 标题取中文，认不出的路径原文返回（settings-labels.ts 的兜底）。 */
    label: settingLabelOf(path, ui.label),
    /* 说明同样取中文；它是人拿来决定要不要改这一格的东西，英文留在原地等于没做。 */
    description: settingDescriptionOf(path, ui.description),
    ...(ui.group === undefined ? {} : { group: ui.group }),
    default: setting.default,
    value: secret ? null : (value ?? null),
    secret,
    hasValue: secret && isConfigured(value),
    ...(options === undefined ? {} : { options }),
    ...(enumValues === undefined ? {} : { enumValues }),
    ...(ui.warning === undefined ? {} : { warning: ui.warning }),
    ...(ui.condition === undefined ? {} : { condition: ui.condition }),
    /* 分节的键仍是 agent 自己的词；这一格只是给人看的那一列。 */
    ...(ui.group === undefined ? {} : { groupLabel: groupLabelOf(ui.group) }),
    /*
     * 这一格的行由产品别处的控件负责：值照报（有别的格子按它决定显不显示），行不画。
     * 判据在 settings-labels.ts 的 ownedElsewhereOf。
     */
    ...(ownedElsewhereOf(path) ? { owned: true } : {}),
    /*
     * 归产品哪一个剥离页画：「记忆」按 agent 自己的 tab 判，「个性化」按 path 名单
     * （上游没有这一栏）。判据与理由都在 settings-labels.ts。两者互斥，记忆优先。
     */
    ...sectionOf(path, ui.tab),
  }
}

/** 这一格归哪个剥离页；不属于任何一页就是空对象（字段如实缺席）。 */
function sectionOf(path: string, tab: string): { section?: 'memory' | 'persona' } {
  if (memorySettingOf(tab)) {
    return { section: 'memory' }
  }

  return personaSettingOf(path) ? { section: 'persona' } : {}
}

/**
 * 钥匙配过没有。
 *
 * 空串也算没配：那与「这一格没写过」在 omp 那边等价（`resolveConfigValue` 把空串
 * 当成没有值），报成「配过」会让界面显示一个用不了的钥匙。
 */
function isConfigured(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false
  }

  if (typeof value === 'string') {
    return value.trim() !== ''
  }

  if (Array.isArray(value)) {
    return value.length > 0
  }

  return typeof value === 'object' ? Object.keys(value).length > 0 : true
}

/** `ui.options` 可能是 `'runtime'`（选项要现算）；那种我们这一层不编，如实缺席。 */
function optionsOf(path: string, options: unknown): readonly SettingOption[] | undefined {
  if (!Array.isArray(options)) {
    return undefined
  }

  const mapped: SettingOption[] = []

  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) {
      continue
    }

    const option = raw as { value?: unknown; label?: unknown; description?: unknown }

    if (typeof option.value !== 'string' || typeof option.label !== 'string') {
      continue
    }

    mapped.push({
      value: option.value,
      /*
       * 选项名取中文；**`value` 一格不译** —— 写回 agent 的就是它，译了等于改错设置。
       * 认不出的格子由 optionLabelOf 原样交回上游 label。
       */
      label: optionLabelOf(path, option.value, option.label),
      ...(typeof option.description === 'string' && option.description !== ''
        ? { description: option.description }
        : {}),
    })
  }

  return mapped.length === 0 ? undefined : mapped
}
