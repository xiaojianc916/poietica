/* Domain-owned vocabulary. The native bridge translates generated wire DTOs at the process boundary. */
export type AppearanceSettings = {
  density: Density
  reduceMotion: boolean
  messageTimestamps: boolean
}
export type AppSettings = {
  theme: ThemePreference
  language: string
  general: GeneralSettings
  appearance: AppearanceSettings
  privacy: PrivacySettings
}
export type CustomAgentCatalog = { files: CustomAgentFile[]; issues: string[] }
export type CustomAgentFile = { relativePath: string; absolutePath: string; document: string }
export type CustomAgentRemoveRequest = { relativePath: string; expectedDocument: string }
export type CustomAgentSaveRequest = {
  relativePath: string
  document: string
  expectedDocument: string | null
}
export type Density = 'comfortable' | 'compact'
export type GeneralSettings = {
  sendWithModifier: boolean
  confirmBeforeDelete: boolean
  notifyOnCompletion: boolean
  /**
   * 守着本地 agent 进程的那一个意图。相位不在这里：它是进程内的事实，
   * 落盘只会得到一份开机就过期的记载。
   */
  daemon: boolean
}
export type PrivacySettings = { telemetry: boolean; crashReporting: boolean; updateCheck: boolean }
export type ThemePreference = 'light' | 'dark' | 'system'
