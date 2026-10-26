/* 启动时那次主题投影。**只订 theme.changed 是不够的**：它只在偏好或系统深浅变化时发，首帧到 Core ready 之间一条都没有，而 index.html
 * 写死 data-theme="light" —— 选了「深色」的机器冷启动仍是浅色，要回外观页再点一次（真实故障）。 */

import { withViewTransition } from '@poietica/design-system'

export type ResolvedTheme = 'light' | 'dark'
export type ThemePreference = 'light' | 'dark' | 'system'

export function resolveStartupTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * 换肤。整窗换一套底色，硬切会闪一下；套一层视图过渡，浏览器拿换肤前后的两张快照补间。
 *
 * 两个出口保持原样（同步、无动画）：首次投影（根上还没有 data-theme，快照没有「旧」可言，
 * 冷启动淡入一次反而像加载动画）、以及值没变（重复通知不该起过渡）。
 */
export function applyResolvedTheme(resolved: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  if (root.dataset.theme === resolved) return
  if (root.dataset.theme === undefined) {
    root.dataset.theme = resolved
    return
  }
  withViewTransition(() => {
    root.dataset.theme = resolved
  })
}
