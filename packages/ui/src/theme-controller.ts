export type ThemePreference = 'light' | 'dark' | 'system'

const DARK_QUERY = '(prefers-color-scheme: dark)'

let removeSystemListener: (() => void) | undefined

export function applyThemePreference(theme: ThemePreference): void {
  removeSystemListener?.()
  removeSystemListener = undefined

  const root = document.documentElement

  /*
   * data-theme 之外必须同时写 color-scheme：原生滚动条、表单控件与
   * <input type="date"> 的下拉面板只认 color-scheme，不认自定义属性，
   * 否则暗色下这些原生表面仍然是亮的。
   */
  const apply = (dark: boolean) => {
    const scheme = dark ? 'dark' : 'light'

    root.setAttribute('data-theme', scheme)
    root.style.colorScheme = scheme
  }

  if (theme === 'light' || theme === 'dark') {
    apply(theme === 'dark')
    return
  }

  const query = window.matchMedia(DARK_QUERY)
  const synchronize = () => apply(query.matches)

  query.addEventListener('change', synchronize)

  removeSystemListener = () => {
    query.removeEventListener('change', synchronize)
  }

  synchronize()
}
