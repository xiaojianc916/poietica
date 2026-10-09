// 本文件是全仓唯一调用 lookup 的地方（12 页 §5.1）。omp 18.5.0 把设置改成**注册**出来的：
// 各域自己 register()、config/all-settings.ts 汇总。不导入它，注册表是空的 —— lookup 永远返回
// undefined，而且不报错，只会让设置目录静默变成 0 格（legacy 踩过这个坑）。
import '@oh-my-pi/pi-coding-agent/config/all-settings'
import { type AnySetting, lookup, type ScopeLike } from '@oh-my-pi/pi-coding-agent/config/registry'
import { AppError, SystemErrorCode } from '@poietica/foundation'

/** 设置句柄的作用域（root Settings 或它的 overlay） */
export type SettingsScope = ScopeLike

/** 按 path 寻址一格设置；认不出的路径如实报错，不静默（这是唯一的路径解析点） */
export function settingAt(path: string): AnySetting {
  const setting = lookup(path)
  if (setting === undefined) throw new AppError(SystemErrorCode.invalidParams, `omp 没有这个设置：${path}`)
  return setting
}

/** 读一格：各层合并后的值，谁都没配就是它自己的默认 */
export function readSetting(scope: SettingsScope, path: string): unknown {
  return settingAt(path).get(scope)
}

/** 写一格：落全局层（调用方随后 flush） */
export function writeGlobalSetting(scope: SettingsScope, path: string, value: unknown): void {
  settingAt(path).set(scope, value as never)
}

export function unsetGlobalSetting(scope: SettingsScope, path: string): void {
  settingAt(path).unset(scope)
}

/** 只写运行时覆盖层，不落盘（端口每次启动都不同的值走这里） */
export function overrideSetting(scope: SettingsScope, path: string, value: unknown): void {
  settingAt(path).override(scope, value as never)
}

export function clearSettingOverride(scope: SettingsScope, path: string): void {
  settingAt(path).clearOverride(scope)
}

/**
 * 这一格有没有被**谁显式配过**（全局、项目或运行时覆盖），而不是回落到 schema 默认。
 * 判「有没有人选过」只能问它，不能读值：值与默认相同时读不出来（omp 知识 #11 依赖这个区分）。
 */
export function isConfiguredSetting(scope: SettingsScope, path: string): boolean {
  return settingAt(path).isConfigured(scope)
}

/** 这一格是不是凭据（值出了 agent 的进程就不再是我们的盘） */
export function isCredentialSetting(path: string): boolean {
  return settingAt(path).isCredential === true
}

export function settingDefaultOf(path: string): unknown {
  return settingAt(path).default
}

export interface SettingUiMetadata {
  readonly label: string
  readonly description: string | undefined
  readonly group: string | undefined
  /** omp 自己的栏（appearance / model / interaction / context / memory / …）—— 归属判据读它 */
  readonly tab: string
  /** 选项表的原文（`{value,label}` 或裸字符串）；`'runtime'` 这类现算的如实交回 undefined */
  readonly options: readonly SettingOptionRaw[] | undefined
  /** 风险提示（会把用户拉进限流或封号的那类设置），原样上屏 */
  readonly warning: string | undefined
  /** 可见性条件的**名字**，不是判据：求值在界面那一侧 */
  readonly condition: string | undefined
}

/** omp 自报的选项形状：`{value,label,description}`，也见过裸字符串。 */
export interface SettingOptionRaw {
  readonly value: string
  readonly label: string
  readonly description: string | undefined
}

/** 那一格自报的界面元数据：label / description / group / tab / 选项表 / 提示 / 条件都从 omp 读，一格都不抄 */
export function settingUiOf(path: string): SettingUiMetadata {
  const setting = settingAt(path) as unknown as {
    ui?: {
      label?: string
      description?: string
      group?: string
      tab?: string
      options?: unknown
      warning?: string
      condition?: string
    }
  }
  const ui = setting.ui
  return {
    label: ui?.label ?? path,
    description: ui?.description,
    group: ui?.group,
    tab: ui?.tab ?? '',
    options: optionsRawOf(ui?.options),
    warning: ui?.warning,
    condition: ui?.condition,
  }
}

/*
 * 选项表的原文。omp 的 `ui.options` 有两种形状与一种「现算」：
 *
 *   - `{value,label,description}`（枚举类的常规形状）；
 *   - 裸字符串（个别格子只给取值）；
 *   - `'runtime'` —— 选项由运行时层算（主题表那类）。我们这一层不编，如实交回 undefined：
 *     编一张空表会让界面画一个选不出东西的下拉。
 */
function optionsRawOf(raw: unknown): readonly SettingOptionRaw[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SettingOptionRaw[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ value: item, label: item, description: undefined })
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const option = item as { value?: unknown; label?: unknown; description?: unknown }
    if (typeof option.value !== 'string') continue
    out.push({
      value: option.value,
      label: typeof option.label === 'string' ? option.label : option.value,
      description: typeof option.description === 'string' ? option.description : undefined,
    })
  }
  return out.length === 0 ? undefined : out
}

/** 上游注册表里的全部设置 id（供目录维护者核对产品开放的键） */
export async function orderedSettingIds(): Promise<readonly string[]> {
  const registry = await import('@oh-my-pi/pi-coding-agent/config/registry')
  return registry.all().map((s) => s.id)
}
