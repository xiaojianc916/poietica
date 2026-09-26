/*
 * agent 自己那份设置目录的读法。
 *
 * 逐格从 omp 的 settings-schema 读出来，一格都不抄：`label` / `description` / 类型 /
 * 选项表都是它自报的（config/settings-schema.ts 的 getUi / getType / getDefault /
 * getEnumValues / isCredential），我们只负责画。抄一份就是第二个事实 —— 升级 omp
 * 时两份必然分叉（AGENTS.md §0）。
 *
 * 中文只有**给我们看的那一列**换成译文（settings-labels.ts）：`label` 换成中文，
 * 认不出的路径原文返回。`path` / `tab` / `group` **一律是 omp 自己的标识符** ——
 * 界面拿它们做联表与分组（agent-settings.tsx 的 `entry.tab === current`、按
 * `entry.group` 建 Map），换成中文就把两栏两节合成一格，屏幕看不出哪里错了。
 *
 * 钥匙那三格（mnemopi.embeddingApiKey / mnemopi.llmApiKey / hindsight.apiToken）
 * **只有有没有值**这一件出得去：值本身出了 agent 的进程就不再是我们的盘。
 */

import {
  getDefault,
  getEnumValues,
  getType,
  getUi,
  hasUi,
  isCredential,
  SETTINGS_SCHEMA,
  type SettingPath,
} from '@oh-my-pi/pi-coding-agent/config/settings-schema'
import type { SettingEntry, SettingOption } from './protocol.ts'
import { settingDescriptionOf } from './settings-descriptions.ts'
import {
  groupLabelOf,
  irrelevantSettingOf,
  ownedElsewhereOf,
  settingLabelOf,
} from './settings-labels.ts'

/** 读设置的那一面：只有 `get`，写不在这里（写走调用方自己的持久层）。 */
export interface SettingsReader {
  get(key: string): unknown
}

/** omp 那一栏的名字，与 pi-tui 的 SettingTab 同域；不在这里另立一套词。 */
export const SETTING_TABS: readonly string[] = [
  'appearance',
  'model',
  'interaction',
  'context',
  'memory',
  'files',
  'shell',
  'tools',
  'tasks',
  'providers',
]

/**
 * 整份目录，或只给某一栏。
 *
 * 只有带 ui 元数据的那几格上屏：没有元数据的格子是内部件（`modelPattern*` 这类），
 * omp 自己的设置面板也不画它们 —— 画出来是我们替它做了一个它没做的决定。
 *
 * 两类格子仍然**报值但不上屏**（`owned` 标着）：一类跟这台桌面软件无关（终端渲染那些，
 * 见 `irrelevantSettingOf`），一类产品已经有专属控件管着（计划/目标/思考档位/审批/浏览器，
 * 见 `ownedElsewhereOf`）。它们必须留在目录里，因为别的格子按 `condition` 读它们的 value
 * 决定显不显示 —— 抽掉值，那几行会永远消失而没有迹象。
 */
export function readCatalog(settings: SettingsReader, tab?: string | null): SettingEntry[] {
  const wanted = tab ?? undefined
  const entries: SettingEntry[] = []

  for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
    if (!hasUi(path)) {
      continue
    }

    const ui = getUi(path)

    if (ui === undefined || (wanted !== undefined && ui.tab !== wanted)) {
      continue
    }

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

    entries.push(entryOf(path, ui, settings))
  }

  return entries
}

function entryOf(
  path: SettingPath,
  ui: NonNullable<ReturnType<typeof getUi>>,
  settings: SettingsReader,
): SettingEntry {
  /*
   * 钥匙那一格：只报有没有值。
   *
   * 读是必须的（不读就不知道配没配），但**读到的那一份绝不进结果**：值直接喂进
   * isConfigured 里折成一个布尔，中间不落任何会被序列化出去的格（AGENTS.md §1
   * 「密钥永不落我们的盘」）。这不是顺手写的一行，是这一层唯一的隐私边界。
   */
  const secret = isCredential(path)
  const value = settings.get(path)
  const options = optionsOf(ui.options)
  // 有 options 就不再报 enumValues：两张表说的是同一件事，报两份会让界面挑花眼。
  const enumValues = options === undefined ? getEnumValues(path) : undefined

  return {
    path,
    type: getType(path),
    /* 标题取中文，认不出的路径原文返回（settings-labels.ts 的兜底）。 */
    label: settingLabelOf(path, ui.label),
    /* 说明同样取中文；它是人拿来决定要不要改这一格的东西，英文留在原地等于没做。 */
    description: settingDescriptionOf(path, ui.description),
    tab: ui.tab,
    ...(ui.group === undefined ? {} : { group: ui.group }),
    default: getDefault(path),
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
  }
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
function optionsOf(options: unknown): readonly SettingOption[] | undefined {
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
      label: option.label,
      ...(typeof option.description === 'string' && option.description !== ''
        ? { description: option.description }
        : {}),
    })
  }

  return mapped.length === 0 ? undefined : mapped
}
