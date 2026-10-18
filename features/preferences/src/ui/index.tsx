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
import { applyResolvedTheme, resolveStartupTheme, systemPrefersDark } from './theme'

export default defineUiFeature({
  id: 'preferences',
  setup(ctx) {
    const api = createPreferencesApi(ctx)
    const navigation = ctx.services.get(NavigationToken) as NavigationService
    const layout = ctx.services.get(LayoutToken) as LayoutService
    const keybindings = ctx.services.get(KeybindingsToken) as KeybindingService
    ctx.services.get(CommandsToken) as CommandService

    // setup 同步而 prefs.get 异步：先拿默认值兜底，拿到真值后替换（下面「首帧就解一次」那一处一并替换）。
    let current: () => Preferences = () => PreferencesSchema.parse({})
    const listeners = new Set<(p: never) => void>()
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

    const applyThemePreference = (preference: 'light' | 'dark' | 'system'): void => {
      applyResolvedTheme(resolveStartupTheme(preference, systemPrefersDark()))
    }
    const applyAppearance = (p: Awaited<ReturnType<PreferencesRpcApi['get']>>): void => {
      document.documentElement.dataset.density = p.appearance.density
      if (p.appearance.reduceMotion) document.documentElement.dataset.reduceMotion = 'true'
      else delete document.documentElement.dataset.reduceMotion
    }

    /*
     * 审查 R-19-2：主题必须在第一次渲染之前就落到文档根上，不能等 prefs.get 回来。
     * Host 在建窗口之前已经把 nativeTheme.themeSource 设成了偏好（preferences/host 的 beforeWindow），
     * 所以渲染层此刻读到的 prefers-color-scheme **就是解析后的那一档**（选浅色 / 深色时被强制，选跟随系统时是系统那档）。
     * 同步投一次，prefs.get 回来再以偏好为准校一次；prefs.get 失败时也不会停在浅色。
     */
    applyResolvedTheme(systemPrefersDark() ? 'dark' : 'light')

    /* 首帧就解一次：偏好住在 Host 的 JSON 里，渲染层只能问一次；不等 Core ready，主题是外壳自己的事。 */
    void api.get().then(
      (p) => {
        current = () => p
        applyThemePreference(p.theme)
      },
      () => undefined,
    )

    /*
     * 审查 R-19-3：布局（侧栏开合 / 宽度、右栏）同样住在 Host 的 uiState 里，与 Core 无关 —— 在 setup 里就恢复。
     * 以前放在 onCoreReady 里，要等 Core 起来（冷启动常常好几秒）：这段时间外壳按 DEFAULT_LAYOUT 画，
     * Core 一就绪再跳到存下的状态，列宽变化还带过渡动画 —— 看上去就是「侧栏先是一个样子、过一会儿自己变了」。
     * 这条请求先于 kernel.start 里的 core.getStatus 发出、同一条通道按序应答，所以 restore 落在第一次渲染之前。
     */
    let layoutRestored = false
    void api
      .uiStateGet('layout')
      .then(
        (saved) => {
          if (saved !== null && saved !== undefined) layout.restore(saved)
        },
        () => undefined,
      )
      .finally(() => {
        layoutRestored = true
      })

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

      // 读 uiState 并 restore（不进入历史）。布局已在 setup 里恢复（R-19-3）；路由要等 Core：目标表面一挂载就要向 Core 要数据。
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
    ctx.lifecycle.onDispose(api.onThemeChanged(applyResolvedTheme).dispose)
    ctx.lifecycle.onDispose(
      api.onKeymapChanged((o) => {
        keybindings.setOverrides(o)
      }).dispose,
    )

    let restoring = true
    ctx.lifecycle.onDispose(
      layout.subscribe(() => {
        /* 恢复完成之前不写回：否则 DEFAULT_LAYOUT 会先把存下的那份盖掉。恢复完成之后不必等 Core —— 启动期间点了侧栏也要记住。 */
        if (!layoutRestored) return
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
