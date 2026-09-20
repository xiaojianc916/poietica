export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

export interface ThemePreferenceBinding {
  readonly resolved: ResolvedTheme
  readonly dispose: () => void
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement

  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
}

export function applyThemePreference(
  theme: ThemePreference,
  onSystemThemeChange: (theme: ResolvedTheme) => void,
  /**
   * 宿主已经裁决过的那一档，只对 `system` 有意义。
   *
   * 跟随系统时 `prefers-color-scheme` 由原生主题推出来，而解钉到 WebView2 生效之间
   * 隔着一次异步消息 —— 就地读 matchMedia 拿到的是上一个偏好。所以首解由宿主给，
   * 此后系统再变才由 matchMedia 报。不传就是自己解，与本函数原先的行为一致。
   */
  resolvedByHost?: ResolvedTheme,
): ThemePreferenceBinding {
  if (theme === 'light' || theme === 'dark') {
    applyResolvedTheme(theme)
    return { resolved: theme, dispose: () => undefined }
  }

  const query = window.matchMedia(DARK_QUERY)
  const resolve = (): ResolvedTheme => (query.matches ? 'dark' : 'light')
  const synchronize = () => {
    const resolved = resolve()
    applyResolvedTheme(resolved)
    onSystemThemeChange(resolved)
  }

  query.addEventListener('change', synchronize)
  const resolved = resolvedByHost ?? resolve()
  applyResolvedTheme(resolved)

  return {
    resolved,
    dispose: () => {
      query.removeEventListener('change', synchronize)
    },
  }
}
