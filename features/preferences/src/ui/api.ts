import type { UiFeatureContext } from '@poietica/ui-kernel'
import {
  type KeyOverrides,
  type Preferences,
  type PreferencesPatch,
  preferencesContract,
  type UiStateKey,
} from '../contract'

/** 对 ctx.rpc(preferencesContract) 的薄封装：测试时整体替换为假对象 */
export function createPreferencesApi(ctx: UiFeatureContext) {
  const rpc = ctx.rpc(preferencesContract)
  return {
    get: (): Promise<Preferences> => rpc.call('prefs.get', {}),
    update: (patch: PreferencesPatch): Promise<Preferences> => rpc.call('prefs.update', { patch }),
    uiStateGet: (key: UiStateKey): Promise<unknown> => rpc.call('uiState.get', { key }).then((r) => r.value),
    uiStateSet: (key: UiStateKey, value: unknown): Promise<void> =>
      rpc.call('uiState.set', { key, value }).then(() => undefined),
    themeSet: (mode: 'system' | 'light' | 'dark'): Promise<{ resolved: 'light' | 'dark' }> =>
      rpc.call('theme.set', { mode }),
    keymapGet: (): Promise<KeyOverrides> => rpc.call('keymap.get', {}).then((r) => r.overrides),
    keymapSet: (commandId: string, key: string | null): Promise<KeyOverrides> =>
      rpc.call('keymap.set', { commandId, key }).then((r) => r.overrides),
    keymapReset: (): Promise<KeyOverrides> => rpc.call('keymap.reset', {}).then((r) => r.overrides),
    onPrefsChanged: (listener: (p: Preferences) => void) => rpc.on('prefs.changed', listener),
    onThemeChanged: (listener: (resolved: 'light' | 'dark') => void) =>
      rpc.on('theme.changed', (p) => listener(p.resolved)),
    onKeymapChanged: (listener: (o: KeyOverrides) => void) => rpc.on('keymap.changed', (p) => listener(p.overrides)),
  }
}

export type PreferencesRpcApi = ReturnType<typeof createPreferencesApi>
