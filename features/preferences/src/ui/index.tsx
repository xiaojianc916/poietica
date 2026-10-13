import type { IconComponent } from '@poietica/ui-kernel'
import {
  builtinPoints,
  type CommandService,
  CommandsToken,
  defineUiFeature,
  type KeybindingService,
  KeybindingsToken,
  type LayoutService,
  LayoutToken,
  type NavigationService,
  NavigationToken,
  type Route,
  SETTINGS_GROUPS,
  type SurfaceComponent,
} from '@poietica/ui-kernel'
import { Keyboard, Settings, Sun } from 'lucide-react'
import { type Preferences, Preferences as PreferencesSchema } from '../contract'
import { type PreferencesApi, PreferencesToken } from '../ui-api'
import { createPreferencesApi, type PreferencesRpcApi } from './api'
import { AppearancePage, GeneralPage, KeymapPage } from './settings-pages'
import { resolveStartupTheme, systemPrefersDark } from './theme'

export default defineUiFeature({
  id: 'preferences',
  setup(ctx) {
    const api = createPreferencesApi(ctx)
    const navigation = ctx.services.get(NavigationToken) as NavigationService
    const layout = ctx.services.get(LayoutToken) as LayoutService
    const keybindings = ctx.services.get(KeybindingsToken) as KeybindingService
    ctx.services.get(CommandsToken) as CommandService

    // setup 同步而 prefs.get 异步：先拿默认值兜底，拿到真值后替换。
    let current: () => Preferences = () => PreferencesSchema.parse({})
    const listeners = new Set<(p: never) => void>()
    void api
      .get()
      .then((p) => {
        current = () => p
      })
      .catch(() => undefined)
    const preferencesApi: PreferencesApi = {
      current: () => current(),
      subscribe: (listener) => {
        listeners.add(listener as never)
        return () => {
          listeners.delete(listener as never)
        }
      },
      update: async (patch) => {
        await api.update(patch)
      },
    }
    ctx.services.provide(PreferencesToken, preferencesApi)

    const applyTheme = (resolved: 'light' | 'dark'): void => {
      document.documentElement.dataset.theme = resolved
    }
    const applyThemePreference = (preference: 'light' | 'dark' | 'system'): void => {
      applyTheme(resolveStartupTheme(preference, systemPrefersDark()))
    }
    const applyAppearance = (p: Awaited<ReturnType<PreferencesRpcApi['get']>>): void => {
      document.documentElement.dataset.density = p.appearance.density
      if (p.appearance.reduceMotion) document.documentElement.dataset.reduceMotion = 'true'
      else delete document.documentElement.dataset.reduceMotion
    }

    /* 首帧就解一次：偏好住在 Host 的 JSON 里，渲染层只能问一次；不等 Core ready，主题是外壳自己的事。 */
    void api.get().then(
      (p) => {
        applyThemePreference(p.theme)
      },
      () => undefined,
    )

    const page = (
      id: string,
      group: string,
      order: number,
      title: string,
      icon: IconComponent,
      Component: () => React.ReactElement,
    ): SurfaceComponent => {
      ctx.contribute(builtinPoints.settingsPages, { id, group, order, title, icon, component: Component })
      return Component
    }
    page('preferences.general', SETTINGS_GROUPS.app, 100, '通用', Settings, () => <GeneralPage api={api} />)
    page('preferences.appearance', SETTINGS_GROUPS.app, 110, '外观', Sun, () => <AppearancePage api={api} />)
    page('preferences.keymap', SETTINGS_GROUPS.agent, 530, '快捷键', Keyboard, () => <KeymapPage api={api} />)

    ctx.lifecycle.onCoreReady(async () => {
      const prefs = await api.get()
      current = () => prefs
      applyThemePreference(prefs.theme)
      applyAppearance(prefs)
      for (const l of [...listeners]) (l as (p: unknown) => void)(prefs)

      // 读 uiState 并 restore（不进入历史）。
      const layoutState = await api.uiStateGet('layout').catch(() => null)
      if (layoutState !== null) layout.restore(layoutState)
      const route = (await api.uiStateGet('navigation')) as Route | null
      if (route !== null) navigation.restore(route)

      keybindings.setOverrides(await api.keymapGet().catch(() => ({})))
    })

    ctx.lifecycle.onDispose(
      api.onPrefsChanged((p) => {
        current = () => p
        /* 先解一次主题（theme.changed 随后就到、以它为准）：保证点一下外观页在任何通知次序下都立刻见效。 */
        applyThemePreference(p.theme)
        applyAppearance(p)
        for (const l of [...listeners]) (l as (p: unknown) => void)(p)
      }).dispose,
    )
    ctx.lifecycle.onDispose(api.onThemeChanged(applyTheme).dispose)
    ctx.lifecycle.onDispose(
      api.onKeymapChanged((o) => {
        keybindings.setOverrides(o)
      }).dispose,
    )

    let restoring = true
    ctx.lifecycle.onDispose(
      layout.subscribe(() => {
        if (restoring) return
        void api.uiStateSet('layout', layout.current())
      }),
    )
    ctx.lifecycle.onDispose(
      navigation.subscribe(() => {
        if (restoring) return
        void api.uiStateSet('navigation', navigation.current().route)
      }),
    )
    ctx.lifecycle.onCoreReady(() => {
      restoring = false
    })
  },
})
