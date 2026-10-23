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

/**
 * 每个 uiState 键**什么时候读回来**。uiState 住在 Host 的 JSON 里、与 Core 无关，所以默认答案是「功能 setup 里就恢复」——
 * 排进 onCoreReady 就是「冷启动这几秒先按默认画、Core 一就绪再跳成存下的样子」（布局 R-19-3、路由、草稿、批准方式都踩过）。
 * - `setup`：首帧就要用 → 在 setup 里经 `PreferencesApi.uiStateSlot`（ui-api）恢复，写回闸门也由它管；
 * - `onDemand`：只在某个页面打开时读，不影响首帧；
 * - `reserved`：契约里登记了、目前没有代码读写（留着是因为删键要提协议版本）。
 * 表是**穷举**的：新加一个键不在这里声明阶段，编译就过不了。
 */
export type UiStateRestorePhase = 'setup' | 'onDemand' | 'reserved'

export const UI_STATE_RESTORE = {
  layout: { phase: 'setup', owner: 'preferences', note: '侧栏开合 / 宽度、右栏；读失败照常写回' },
  navigation: { phase: 'setup', owner: 'preferences', note: '上次停在哪一页；形状不对留在 defaultRoute' },
  'conversation.drafts': {
    phase: 'setup',
    owner: 'conversation',
    note: '每格草稿与入口页选择器；读失败保持未恢复、不写回，onCoreReady 重试',
  },
  'conversation.permissionPosture': { phase: 'setup', owner: 'conversation', note: '入口页批准方式的持久意图' },
  'mascot.autoTour': { phase: 'onDemand', owner: 'preferences', note: '外观页打开时读' },
  'mascot.followPointer': { phase: 'onDemand', owner: 'preferences', note: '外观页打开时读' },
  'sidebar.collapsedSections': { phase: 'reserved', owner: 'conversation', note: '没有代码读写' },
  'review.lastBase': { phase: 'reserved', owner: 'review', note: '没有代码读写' },
} as const satisfies Record<
  UiStateKey,
  { readonly phase: UiStateRestorePhase; readonly owner: string; readonly note: string }
>

/** 只有声明为 `setup` 的键能开 uiState 槽（`PreferencesApi.uiStateSlot`）。 */
export type SetupUiStateKey = {
  [K in UiStateKey]: (typeof UI_STATE_RESTORE)[K]['phase'] extends 'setup' ? K : never
}[UiStateKey]

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
