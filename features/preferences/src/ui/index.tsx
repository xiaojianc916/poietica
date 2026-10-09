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

    // ── ui-api：给其它功能的只读视图 ────────────────────────────────
    // setup 是同步的而 prefs.get 是异步的：先拿一份默认值兜底，拿到真值后替换。
    // 这样任何功能在自己的 setup 里读 PreferencesToken.current() 都不会炸。
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
    /** 按偏好解一次并落盘到文档根；判据在 theme.ts 里，这里只接线。 */
    const applyThemePreference = (preference: 'light' | 'dark' | 'system'): void => {
      applyTheme(resolveStartupTheme(preference, systemPrefersDark()))
    }
    const applyAppearance = (p: Awaited<ReturnType<PreferencesRpcApi['get']>>): void => {
      document.documentElement.dataset.density = p.appearance.density
      if (p.appearance.reduceMotion) document.documentElement.dataset.reduceMotion = 'true'
      else delete document.documentElement.dataset.reduceMotion
    }

    /*
     * 首帧就在解一次：偏好住在 Host 的 JSON 里，渲染层知道真相的唯一途径是问一次。
     * 不等 Core ready —— 主题与窗口底色是外壳自己的事，Core 还没起来也该是深色。
     */
    void api.get().then(
      (p) => {
        /*
         * 只投影主题。密度与减少动效等到 Core ready 的完整同步再落 —— 在这里多写一笔
         * 等于假设读回来的偏好已经是完整的，而首帧那一份可能只有主题一格
         * （渲染层冒烟测试正是这样把它照出来的）。
         */
        applyThemePreference(p.theme)
      },
      () => undefined,
    )

    // ── 贡献：三个设置页 ────────────────────────────────────────────
    // 图标用 legacy SECTIONS 里那三枚（lucide 的 Settings / Sun / Keyboard），不手描 path。
    // 「通用」是 `Settings`（带孔的齿轮）而不是 `Cog`：legacy 原文 `Settings as CogFour`。
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
    /* 快捷键的段内次序照 legacy：在能力（540）之前 —— 07 页 §2 的 order 530 */
    page('preferences.keymap', SETTINGS_GROUPS.agent, 530, '快捷键', Keyboard, () => <KeymapPage api={api} />)

    // ── Core ready 时做一次整体同步 ──────────────────────────────────
    ctx.lifecycle.onCoreReady(async () => {
      const prefs = await api.get()
      current = () => prefs
      applyThemePreference(prefs.theme)
      applyAppearance(prefs)
      for (const l of [...listeners]) (l as (p: unknown) => void)(prefs)

      // 布局与导航记忆：读 uiState 并 restore（不进入历史）
      const layoutState = await api.uiStateGet('layout').catch(() => null)
      if (layoutState !== null) layout.restore(layoutState)
      const route = (await api.uiStateGet('navigation')) as Route | null
      if (route !== null) navigation.restore(route)

      // 快捷键覆盖
      keybindings.setOverrides(await api.keymapGet().catch(() => ({})))
    })

    // ── 订阅：偏好变化 / 主题 / 快捷键表 ────────────────────────────
    ctx.lifecycle.onDispose(
      api.onPrefsChanged((p) => {
        current = () => p
        /*
         * 偏好一到就先把主题解一次。`theme.changed` 随后就到（Host 的副作用顺序是
         * 广播 → 执行副作用），以它为准；这里先落的这一笔保证「点一下外观页」在任何
         * 通知次序下都立刻见效，不用等下一次订阅。
         */
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

    // ── 记忆布局与导航（去抖由 Host 负责） ──────────────────────────
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
