export type ThemeMode = 'light' | 'dark' | 'system'

/** 列表与消息的疏密。与 Rust 的 Density 是同一个闭集。 */
export type UiDensity = 'comfortable' | 'compact'

export interface GeneralSettings {
  readonly sendWithModifier: boolean
  readonly confirmBeforeDelete: boolean
  readonly notifyOnCompletion: boolean
  /** 守着本地 agent 进程的那一个意图。相位归原生侧，不在设置里。 */
  readonly daemon: boolean
}

export interface AppearanceSettings {
  readonly density: UiDensity
  readonly reduceMotion: boolean
  readonly messageTimestamps: boolean
}

export interface PrivacySettings {
  readonly telemetry: boolean
  readonly crashReporting: boolean
  readonly updateCheck: boolean
}

/*
 * 应用设置的形状。
 *
 * 真相来源是 src-tauri 的 AppSettings，这里是它在领域侧的同形副本：字段名、类型
 * 与默认值必须逐条对齐，任何一侧先改都会让另一侧的读写落空。
 *
 * 此前这里有一个 shortcuts 表：全仓没有一个读取点，桌面适配层却为它专门维护着
 * 一层翻译。快捷键的真相在命令注册表里（每个命令自己声明 shortcut），设置面板
 * 读的是那份声明的投影，不是这里的第二张表。
 *
 * theme 与 language 留在顶层，不并进 appearance：它们在第一帧之前就要被读走，
 * 那时"设置有哪些分类"还不存在。
 */
export interface AppSettings {
  readonly theme: ThemeMode
  readonly language: string
  readonly general: GeneralSettings
  readonly appearance: AppearanceSettings
  readonly privacy: PrivacySettings
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  general: {
    sendWithModifier: false,
    confirmBeforeDelete: true,
    notifyOnCompletion: true,
    daemon: true,
  },
  appearance: {
    density: 'comfortable',
    reduceMotion: false,
    messageTimestamps: true,
  },
  privacy: {
    telemetry: false,
    crashReporting: true,
    updateCheck: true,
  },
}
