import { z } from 'zod'

export const Preferences = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  language: z.enum(['zh-CN', 'en']).default('zh-CN'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  general: z
    .object({
      sendWithModifier: z.boolean().default(false),
      confirmBeforeDelete: z.boolean().default(true),
      notifyOnCompletion: z.boolean().default(true),
    })
    // prefault：default 要求给完整输出形状，所以缺省输入也要走一遍。
    .prefault({}),
  appearance: z
    .object({
      density: z.enum(['comfortable', 'compact']).default('comfortable'),
      reduceMotion: z.boolean().default(false),
      messageTimestamps: z.boolean().default(false),
    })
    .prefault({}),
  modelPicker: z
    .object({
      hiddenModels: z.array(z.string()).default([]),
      providerOrder: z.array(z.string()).default([]),
    })
    .prefault({}),
  updates: z.object({ autoCheck: z.boolean().default(true) }).prefault({}),
})
export type Preferences = z.infer<typeof Preferences>

export const PreferencesPatch = z.object({
  theme: Preferences.shape.theme.unwrap().optional(),
  language: Preferences.shape.language.unwrap().optional(),
  logLevel: Preferences.shape.logLevel.unwrap().optional(),
  general: Preferences.shape.general.unwrap().partial().optional(),
  appearance: Preferences.shape.appearance.unwrap().partial().optional(),
  modelPicker: Preferences.shape.modelPicker.unwrap().partial().optional(),
  updates: Preferences.shape.updates.unwrap().partial().optional(),
})
export type PreferencesPatch = z.infer<typeof PreferencesPatch>

/** uiState 键是**封闭枚举**：新增键必须改契约并提升协议版本，否则会变成各功能随手塞东西的杂物箱。 */
export const UiStateKey = z.enum([
  'layout',
  'navigation',
  'sidebar.collapsedSections',
  'conversation.drafts',
  'conversation.permissionPosture',
  'review.lastBase',
  'mascot.autoTour',
  'mascot.followPointer',
])
export type UiStateKey = z.infer<typeof UiStateKey>

/** 枚举之外的键**丢弃**，不把整份文件判成坏文件；值保持 unknown。 */
export const UiState = z.record(z.string(), z.unknown()).transform((value) => {
  const out: Partial<Record<UiStateKey, unknown>> = {}
  for (const key of UiStateKey.options) {
    if (Object.hasOwn(value, key)) out[key] = value[key]
  }
  return out
})
export type UiState = z.infer<typeof UiState>

export const KeyOverrides = z.record(z.string(), z.string().nullable())
export type KeyOverrides = z.infer<typeof KeyOverrides>
