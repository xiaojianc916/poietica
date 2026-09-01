import type { AppSettings } from './settings'

/** 设置存取端口；持久化机制由注入的实现负责。 */
export interface SettingsStore {
  readonly load: () => Promise<AppSettings>
  readonly save: (settings: AppSettings) => Promise<void>
  readonly reset: () => Promise<AppSettings>
}
