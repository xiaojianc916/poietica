import { defineServiceToken } from '@poietica/foundation'
import type { SettingContext, SettingDefinition, SettingScope, SettingView } from '../contract/entities'

export interface SettingsService {
  register(definition: SettingDefinition): void
  get(key: string, context?: SettingContext): SettingView
  set(input: { key: string; scope: SettingScope; scopeId: string; value: unknown }): void
  describe(context?: SettingContext): readonly SettingView[]
}

export const SettingsServiceToken = defineServiceToken<SettingsService>('settings', 'SettingsService')
