/*
 * 启动时的那一次主题投影。
 *
 * 主题有两个来源：Host 算好的 `theme.changed` 通知，与偏好里那一格 `theme`（可能是
 * `system`）。**只订通知是不够的**：那条通知只在偏好变化与系统深浅变化时发，首帧到
 * Core ready 之间一条都没有，而 index.html 上写死 `data-theme="light"` —— 于是选了
 * 「深色」的机器冷启动仍是浅色，要人手回外观页再点一次才刷新（真实故障）。
 *
 * 所以启动这一次由渲染层自己解：`light` / `dark` 直接用，`system` 读系统此刻那一档。
 * 此后系统再变仍由 `theme.changed` 接管（Host 的 `nativeTheme.on('updated')`）。
 */

export type ResolvedTheme = 'light' | 'dark'
export type ThemePreference = 'light' | 'dark' | 'system'

/** 偏好 + 系统此刻那一档 → 要落到文档上的那一档。 */
export function resolveStartupTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/** 系统此刻是不是深色。matchMedia 在测试环境（happy-dom）与真实 Chromium 都可用。 */
export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 投影到文档根：整份样式表的深浅两支都读 `:root[data-theme=...]`。 */
export function applyResolvedTheme(resolved: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = resolved
}
