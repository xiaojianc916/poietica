import { composerToolkitSources, slashCommands } from '@poietica/feature-conversation/ui-api'
import { BannersToken, builtinPoints, defineUiFeature, NavigationToken, SETTINGS_GROUPS } from '@poietica/ui-kernel'
import { PackageOpen, Plug } from 'lucide-react'
import { createExtensionsApi } from './api'
import { createComposerToolkitSource } from './composer-toolkit'
import { McpSettingsPage } from './mcp-settings'
import { SKILLS_SETTINGS_PAGE } from './skill-document-store'
import { SkillsSettingsPage } from './skills-settings'

export default defineUiFeature({
  id: 'extensions',
  /* conversation：输入框的工具名册（composerToolkitSources）；
   * platform：技能页的「从文件夹安装 / 从 zip 安装」走 dialog.pickFolder / dialog.pickFiles。 */
  dependsOn: ['conversation', 'platform'],
  setup(ctx) {
    const api = createExtensionsApi(ctx)
    const banners = ctx.services.get(BannersToken)
    const navigation = ctx.services.get(NavigationToken)

    /* 名册属于本功能，conversation 只画面板，所以往它的贡献点里放一台来源。两条通知各自刷新一格：skills.changed 清技能缓存，
     * mcp.statusChanged 整份替换 MCP；Core 重启后两边都清空重来。 */
    const composerToolkit = createComposerToolkitSource({ api, logger: ctx.logger })
    ctx.contribute(composerToolkitSources, composerToolkit)
    ctx.lifecycle.onCoreReady(() => {
      composerToolkit.reset()
    })
    ctx.lifecycle.onDispose(api.skills.onChanged(() => composerToolkit.skillsChanged()).dispose)
    ctx.lifecycle.onDispose(api.mcp.onStatusChanged((rows) => composerToolkit.mcpChanged(rows)).dispose)
    ctx.lifecycle.onDispose(() => {
      composerToolkit.stop()
    })

    ctx.contribute(builtinPoints.settingsPages, {
      id: SKILLS_SETTINGS_PAGE,
      group: SETTINGS_GROUPS.agent,
      order: 500,
      title: '技能',
      icon: PackageOpen,
      component: () => <SkillsSettingsPage api={api} />,
    })

    ctx.contribute(builtinPoints.settingsPages, {
      id: 'extensions.mcp',
      group: SETTINGS_GROUPS.agent,
      order: 520,
      title: 'MCP',
      icon: Plug,
      component: () => <McpSettingsPage api={api} />,
    })

    /* 输入框里的 `/mcp`、`/skills`：omp 的同名命令在终端里是子命令，GUI 里这两样都有自己的设置页 —— 命令就是「打开那一页」。 */
    const openPage = (page: string) => (): void => {
      navigation.navigate({ surface: 'workbench.settings', params: { page } })
    }
    ctx.contribute(slashCommands, {
      name: 'mcp',
      description: '打开 MCP 设置',
      order: 100,
      run: openPage('extensions.mcp'),
    })
    ctx.contribute(slashCommands, {
      name: 'skills',
      aliases: ['skill'],
      description: '打开技能设置',
      order: 110,
      run: openPage(SKILLS_SETTINGS_PAGE),
    })

    /* 技能页要提供「从文件夹安装」/「从 zip 安装」，而 legacy 那一页上**没有**这两颗键，产品负责人又要求设置界面与 legacy 逐像素一致 ——
     * 所以能力挂在命令面板上（extensions.installSkillFromFolder / …FromZip）：能力照方案补齐，页面外观照 legacy 保留。 */
    const install = (kind: 'directory' | 'zip') => (): void => {
      void (async () => {
        const platform = api.platform()
        const path =
          kind === 'directory'
            ? (await platform.call('dialog.pickFolder', { title: '选择技能文件夹' })).path
            : ((
                await platform.call('dialog.pickFiles', {
                  filters: [{ name: '技能包', extensions: ['zip'] }],
                  multiple: false,
                })
              ).paths[0] ?? null)

        if (path === null) {
          return
        }

        try {
          await api.skills.install({ kind, path })
          banners.show({ severity: 'success', title: '技能已安装' })
        } catch (cause) {
          banners.error(cause, '技能安装失败')
        }
      })()
    }

    ctx.contribute(builtinPoints.commands, {
      id: 'extensions.installSkillFromFolder',
      title: '从文件夹安装技能',
      category: '技能',
      run: install('directory'),
    })
    ctx.contribute(builtinPoints.commands, {
      id: 'extensions.installSkillFromZip',
      title: '从 zip 安装技能',
      category: '技能',
      run: install('zip'),
    })
  },
})
