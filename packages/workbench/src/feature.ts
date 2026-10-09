import type { LayoutService, NavigationService } from '@poietica/ui-kernel'
import {
  builtinPoints,
  CommandsToken,
  defineUiFeature,
  LayoutToken,
  NavigationToken,
  type Route,
  SETTINGS_GROUPS,
} from '@poietica/ui-kernel'
import { closePalette, openPalette, subscribePalette } from './palette-state'
import { SettingsContentRegion } from './parts/settings-regions'

const SETTINGS_ROUTE: Route = { surface: 'workbench.settings', params: {} }

/**
 * workbench 自己也以一个 UI 功能的身份注册命令与设置界面（id `workbench`），
 * 这样外壳的命令同样可以被用户改键。内核服务的令牌 owner 都是 KERNEL_OWNER，
 * 任何功能都可以取，无需 dependsOn。
 */
export const workbenchFeature = defineUiFeature({
  id: 'workbench',
  setup(ctx) {
    const navigation = ctx.services.get(NavigationToken) as NavigationService
    const layout = ctx.services.get(LayoutToken) as LayoutService
    ctx.services.get(CommandsToken)
    // 命令面板的开关状态由 Workbench 订阅（见 palette-state.ts）
    void subscribePalette

    const command = (id: string, title: string, run: () => void): void => {
      ctx.contribute(builtinPoints.commands, { id, title, category: '外壳', run })
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
    command('workbench.back', '后退', () => {
      navigation.back()
    })
    command('workbench.forward', '前进', () => {
      navigation.forward()
    })
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

    /*
     * 三个标准设置段（06 页 §6.3）。workbench 只认识「段」，不知道哪个页属于哪个功能；
     * 页归哪一段由贡献它的功能用 `group` 声明（段内顺序则由页自己的 `order` 决定）。
     * 段 id 来自 ui-kernel 的 SETTINGS_GROUPS —— 功能写 group 时引用同一份常量。
     */
    const group = (id: string, order: number): void => {
      ctx.contribute(builtinPoints.settingsGroups, { id, order })
    }
    group(SETTINGS_GROUPS.app, 100)
    group(SETTINGS_GROUPS.agent, 200)
    group(SETTINGS_GROUPS.system, 900)

    /*
     * 设置界面注册成**表面**（06 页 §6.3：路由参数 page 选页，缺省选第一页），
     * 但它在外壳里的落点与普通表面不同 —— 打开时是外壳自己的区域换内容：
     * 侧栏区放设置导航、主区放设置内容（迁移自 legacy workspace.tsx 的 isSettingsOpen
     * 分支，见 workbench.tsx）。这个贡献登记的是主区那一格的内容。
     */
    ctx.contribute(builtinPoints.surfaces, {
      id: 'workbench.settings',
      title: '设置',
      component: SettingsContentRegion,
    })
  },
})
