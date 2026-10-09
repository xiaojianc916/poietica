import { z } from 'zod'

export const Preferences = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  // 与 legacy 一致：只保存选择，界面文字目前只有中文
  language: z.enum(['zh-CN', 'en']).default('zh-CN'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  general: z
    .object({
      /** true：Ctrl+Enter 发送，Enter 换行 */
      sendWithModifier: z.boolean().default(false),
      confirmBeforeDelete: z.boolean().default(true),
      notifyOnCompletion: z.boolean().default(true),
    })
    // prefault：缺省输入 {} 也走一遍内部默认值（default 要求给完整的输出形状）
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
      /** 'provider/id' */
      hiddenModels: z.array(z.string()).default([]),
      providerOrder: z.array(z.string()).default([]),
    })
    .prefault({}),
  updates: z.object({ autoCheck: z.boolean().default(true) }).prefault({}),
})
export type Preferences = z.infer<typeof Preferences>

/** prefs.update 的 patch：每个分组都可以只给部分字段 */
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

/**
 * uiState 的键是**封闭枚举**：新增键必须改契约（并提升协议版本），
 * 防止 ui-state.json 变成各功能随手塞东西的杂物箱。
 */
export const UiStateKey = z.enum([
  'layout',
  'navigation',
  'sidebar.collapsedSections',
  'conversation.drafts',
  /*
   * 批准方式的**跨会话意图**（'manual' / 'yolo' / 'auto'，引擎那三档的产品词）。
   *
   * legacy 把它与 default_model 并列成「上一趟的选择」，重开软件要先画出来；新架构里
   * 渲染层记忆的正主就是 uiState（与 `conversation.drafts` 同一条理由）。
   */
  'conversation.permissionPosture',
  'review.lastBase',
  // 吉祥物的两格（legacy 刻意没放进 AppSettings：那张表与原生侧 DTO 逐字段镜像，
  // 而这两项只属于渲染层 —— 新架构里「渲染层记忆」的正主就是 uiState）
  'mascot.autoTour',
  'mascot.followPointer',
])
export type UiStateKey = z.infer<typeof UiStateKey>

/**
 * ui-state.json 的形状（08 页 §6.2）。键是封闭枚举；枚举之外的键按 08 页 §6.1 的
 * “剥离未知字段”语义**丢弃**（新版本删掉的键从旧文件里自动消失），而不是把整份文件判成坏文件。
 * 值保持 unknown：每一格的形状由使用它的功能自己管。
 */
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
