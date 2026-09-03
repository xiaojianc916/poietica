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
  const resolved = resolve()
  applyResolvedTheme(resolved)

  return {
    resolved,
    dispose: () => {
      query.removeEventListener('change', synchronize)
    },
  }
}
