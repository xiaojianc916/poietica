import {
  applyThemePreference,
  type ResolvedTheme,
  type ThemePreference,
  type ThemePreferenceBinding,
} from '@poietica/design-system'
import type { MainWindowController } from '@poietica/native-bridge/window'

export interface ThemeRuntime {
  readonly setPreference: (preference: ThemePreference) => Promise<void>
  readonly dispose: () => void
}

interface ThemeRuntimeOptions {
  readonly mainWindow: Pick<MainWindowController, 'setSurfaceColor'>
  readonly report: (cause: unknown) => void
}

/* 挂到原生窗口上的背景面：与工作区外壳同色（--ui-chrome），拖拽或还原时露出的
   就是它。正本是 packages/design-system/src/tokens/palette.css 的两格，
   tauri.conf.json 与 index.html 各持一份投影，window-surface-policy 核对三处相等。 */
const WINDOW_SURFACES = {
  light: [243, 243, 243],
  dark: [32, 32, 32],
} as const satisfies Readonly<Record<ResolvedTheme, readonly [number, number, number]>>

export function createThemeRuntime({ mainWindow, report }: ThemeRuntimeOptions): ThemeRuntime {
  let binding: ThemePreferenceBinding | null = null
  let currentPreference: ThemePreference | null = null
  let generation = 0
  let disposed = false
  let nativeUpdates = Promise.resolve()

  const synchronizeSurface = (theme: ResolvedTheme): Promise<void> => {
    const color = WINDOW_SURFACES[theme]
    const cssColor = ['rgb(', color.join(' '), ')'].join('')

    document.documentElement.style.setProperty('--window-backing-surface', cssColor)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cssColor)

    const update = nativeUpdates.then(() => mainWindow.setSurfaceColor(color))
    nativeUpdates = update.catch((cause: unknown) => {
      report(cause)
    })
    return nativeUpdates
  }

  const setPreference = (preference: ThemePreference): Promise<void> => {
    if (disposed || preference === currentPreference) {
      return nativeUpdates
    }

    binding?.dispose()
    const activeGeneration = ++generation
    const nextBinding = applyThemePreference(preference, (theme) => {
      if (!disposed && generation === activeGeneration) {
        void synchronizeSurface(theme)
      }
    })

    binding = nextBinding
    currentPreference = preference
    return synchronizeSurface(nextBinding.resolved)
  }

  return {
    setPreference,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      generation += 1
      binding?.dispose()
      binding = null
      currentPreference = null
    },
  }
}
