/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { composerToolkitSources } from '@poietica/feature-conversation/ui-api'
import { builtinPoints, defineUiFeature, SETTINGS_GROUPS, ToastsToken } from '@poietica/ui-kernel'
import { PackageOpen, Plug } from 'lucide-react'
import { createExtensionsApi } from './api'
import { createComposerToolkitSource } from './composer-toolkit'
import { McpSettingsPage } from './mcp-settings'
import { SkillsSettingsPage } from './skills-settings'

export default defineUiFeature({
  id: 'extensions',
  /*
   * conversation：技能页的「查看 SKILL.md」落到右坞那一格（面板住在 conversation，
   * 因为能画 markdown 的 Prose 属于会话的时间线，守则 3 不许 extensions 直接取）。
   * platform：技能页的「从文件夹安装 / 从 zip 安装」走 dialog.pickFolder / dialog.pickFiles。
   */
  dependsOn: ['conversation', 'platform'],
  setup(ctx) {
    const api = createExtensionsApi(ctx)
    const toasts = ctx.services.get(ToastsToken)

    /*
     * 加号面板那张名册（技能 / MCP）。名册属于本功能，conversation 只画面板，所以
     * 往它的贡献点里放一台来源（见 composer-toolkit.ts 的头注与 refactor-log）。
     *
     * 两条通知各自刷新一格：`skills.changed` 清技能缓存（含装 / 删 / 启停），
     * `mcp.statusChanged` 整份替换 MCP（连接状态是推送的，不重读）。Core 重启后
     * 两边都清空重来 —— 那可能是换了一份设置。
     */
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

    // 图标与标题取 legacy SECTIONS（外观的正本）：技能 = PackageOpen，MCP = Plug /「MCP」。
    ctx.contribute(builtinPoints.settingsPages, {
      id: 'extensions.skills',
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

    /*
     * 07 页 §8E 要求技能页提供「从文件夹安装」/「从 zip 安装」（路径走 platform 的
     * dialog.pickFolder / dialog.pickFiles）。legacy 的那一页上**没有**这两颗键
     * （legacy 的 `installSkill` 全仓没有调用点，见 docs/refactor-log.md 偏差 24），
     * 而产品负责人要求设置界面与 legacy 逐像素一致，所以能力不摆在页面上：
     * 它挂在命令面板上（`extensions.installSkillFromFolder` / `…FromZip`）——
     * 能力照方案补齐，页面外观照 legacy 保留。
     */
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
          toasts.show({ severity: 'success', title: '技能已安装' })
        } catch (cause) {
          toasts.error(cause, '技能安装失败')
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
