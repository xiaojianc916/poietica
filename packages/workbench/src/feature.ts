import {
  builtinPoints,
  CommandsToken,
  defineUiFeature,
  LayoutToken,
  NavigationToken,
  type Route,
  SETTINGS_GROUPS,
  settingsDockOwner,
} from '@poietica/ui-kernel'
import { closePalette, openPalette, subscribePalette } from './palette-state'
import { SettingsContentRegion } from './parts/settings-regions'

const SETTINGS_ROUTE: Route = { surface: 'workbench.settings', params: {} }

/**
 * workbench 自己也以一个 UI 功能的身份注册命令与设置界面（id `workbench`），
 * 这样外壳的命令同样可以被用户改键。
 */
export const workbenchFeature = defineUiFeature({
  id: 'workbench',
  setup(ctx) {
    const navigation = ctx.services.get(NavigationToken)
    const layout = ctx.services.get(LayoutToken)
    ctx.services.get(CommandsToken)
    // 命令面板的开关状态由 Workbench 订阅（见 palette-state.ts）
    void subscribePalette

    const command = (id: string, title: string, run: () => void, enabled?: () => boolean): void => {
      ctx.contribute(
        builtinPoints.commands,
        enabled === undefined ? { id, title, category: '外壳', run } : { id, title, category: '外壳', run, enabled },
      )
    }
    command('workbench.commandPalette', '命令面板', openPalette)
    command('workbench.toggleSidebar', '切换侧栏', () => {
      layout.toggleSidebar()
    })
    command('workbench.toggleRightPanel', '切换右侧面板', () => {
      layout.togglePanel('right')
    })
    command('workbench.openSettings', '打开设置', () => {
      navigation.navigate(SETTINGS_ROUTE)
    })
    /* 没有可回退 / 可前进的一页时点下去没反应：自报不可用，命令面板就不画。 */
    command(
      'workbench.back',
      '后退',
      () => {
        navigation.back()
      },
      () => navigation.current().canGoBack,
    )
    command(
      'workbench.forward',
      '前进',
      () => {
        navigation.forward()
      },
      () => navigation.current().canGoForward,
    )
    command('workbench.home', '回到首页', () => {
      navigation.home()
    })
    void closePalette

    const bind = (command_: string, key: string): void => {
      ctx.contribute(builtinPoints.keybindings, { command: command_, key })
    }
    bind('workbench.commandPalette', 'Ctrl+Shift+P')
    bind('workbench.commandPalette', 'Ctrl+K')
    bind('workbench.toggleSidebar', 'Ctrl+B')
    bind('workbench.toggleRightPanel', 'Ctrl+Alt+B')
    bind('workbench.openSettings', 'Ctrl+,')
    bind('workbench.back', 'Alt+ArrowLeft')
    bind('workbench.forward', 'Alt+ArrowRight')

    /* 段 id 来自 ui-kernel 的 SETTINGS_GROUPS：功能写 group 时引用同一份常量。 */
    const group = (id: string, order: number): void => {
      ctx.contribute(builtinPoints.settingsGroups, { id, order })
    }
    group(SETTINGS_GROUPS.app, 100)
    group(SETTINGS_GROUPS.agent, 200)
    group(SETTINGS_GROUPS.system, 900)

    /*
     * 设置注册成**表面**，但落点与普通表面不同：打开时是外壳自己的区域换内容
     * （侧栏放导航、主区放内容，见 workbench.tsx）。这个贡献登记的是主区那一格。
     */
    ctx.contribute(builtinPoints.surfaces, {
      id: 'workbench.settings',
      title: '设置',
      component: SettingsContentRegion,
      /*
       * 设置的右坞**按页分账**：技能页开的技能文档只属于技能页，换到「通用」或退出再进来（落在缺省页）都看不到它。
       * params.page 由 Workbench 先解析成实际落在的那一页再传进来；解析不出页（还没有任何设置页）就不画右坞。
       */
      dockOwner: (params) => (params.page === undefined || params.page === '' ? null : settingsDockOwner(params.page)),
    })
  },
})
