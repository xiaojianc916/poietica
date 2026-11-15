import { defineServiceToken } from '@poietica/foundation'
import type { SettingContext, SettingDefinition, SettingScope, SettingView } from '../contract/entities'

export interface SettingWrite {
  readonly key: string
  readonly scope: SettingScope
  readonly scopeId: string
  readonly value: unknown
}

/**
 * 外部设置后端（§17）：值仍由原主人持有（Host preferences、omp 配置），注册表只负责统一
 * 描述与路由写入，不复制一份。provider 的 key 必须带自己的前缀，避免和本地 DB 设置撞名。
 */
export interface SettingsProvider {
  readonly id: string
  owns(key: string): boolean
  describe(context?: SettingContext): Promise<readonly SettingView[]>
  set?(input: SettingWrite): Promise<void>
}

export interface SettingsService {
  register(definition: SettingDefinition): void
  registerProvider(provider: SettingsProvider): void
  get(key: string, context?: SettingContext): SettingView
  set(input: SettingWrite): void
  /** 写本地设置或转给持有该 key 的 provider；没有 provider 接手时写本地。 */
  write(input: SettingWrite): Promise<void>
  describe(context?: SettingContext): readonly SettingView[]
  /** 本地 + 全部 provider 的合并视图。 */
  describeAll(context?: SettingContext): Promise<readonly SettingView[]>
}

export const SettingsServiceToken = defineServiceToken<SettingsService>('settings', 'SettingsService')
