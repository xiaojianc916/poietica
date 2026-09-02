import type { AppSettings } from './settings'

/** 设置的唯一持久化端口，同时发布最近一次已落盘快照。 */
export interface SettingsStore {
  readonly getSnapshot: () => AppSettings | undefined
  readonly subscribe: (listener: () => void) => () => void
  readonly load: () => Promise<AppSettings>
  readonly save: (settings: AppSettings) => Promise<void>
  readonly reset: () => Promise<AppSettings>
}
