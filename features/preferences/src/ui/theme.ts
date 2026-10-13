/* 启动时那次主题投影。**只订 theme.changed 是不够的**：它只在偏好或系统深浅变化时发，首帧到 Core ready 之间一条都没有，而 index.html
 * 写死 data-theme="light" —— 选了「深色」的机器冷启动仍是浅色，要回外观页再点一次（真实故障）。 */

export type ResolvedTheme = 'light' | 'dark'
export type ThemePreference = 'light' | 'dark' | 'system'

export function resolveStartupTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyResolvedTheme(resolved: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = resolved
}
