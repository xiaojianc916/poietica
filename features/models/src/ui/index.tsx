import { builtinPoints, defineUiFeature, NavigationToken, SETTINGS_GROUPS } from '@poietica/ui-kernel'
import { Cpu } from 'lucide-react'
import { lazy } from 'react'
import { createModelsApi } from './api'
import './models-settings.css'
import { ModelsBanner, useUnconfiguredVisible } from './unconfigured-banner'

/*
 * 设置页与「模型角色」那一组只在设置里出现，按需加载：目录表、认证面板与设置页本体（legacy 逐字迁移的
 * models-settings）都不进首屏入口。入口页的未配置提示（entryNotices）随首帧渲染，保持静态。
 */
const ModelsPage = lazy(() => import('./models-page').then((module) => ({ default: module.ModelsPage })))
const ModelRolesGroup = lazy(() =>
  import('./model-roles-group').then((module) => ({ default: module.ModelRolesGroup })),
)

export default defineUiFeature({
  id: 'models',
  dependsOn: ['preferences'],
  setup(ctx) {
    const api = createModelsApi(ctx)
    const navigation = ctx.services.get(NavigationToken)

    ctx.contribute(builtinPoints.settingsPages, {
      id: 'models.catalog',
      group: SETTINGS_GROUPS.agent,
      order: 300,
      title: '模型',
      icon: Cpu,
      component: () => <ModelsPage api={api} />,
    })

    /* 「模型角色」落在**通用页**里：omp 的 modelRoles（含标题用的 tiny）是模型目录的事实，所以这一组归 models 功能，而不是往 preferences 里塞一份模型知识。 */
    ctx.contribute(builtinPoints.settingsSections, {
      id: 'models.roles',
      order: 400,
      page: 'preferences.general',
      component: () => <ModelRolesGroup api={api} />,
    })

    /* 未配置提示：没有任何 configured 的服务商时显示 + 「去设置」。落点按产品负责人的要求放在**新对话界面的吉祥物上方**（不占独立一行），因此走
     * entryNotices —— 两条判据、文案、动作一字未变，只是画在哪里不同。 */
    ctx.contribute(builtinPoints.entryNotices, {
      id: 'models.unconfigured',
      order: 50,
      component: () => (
        <ModelsBanner
          api={api}
          onGoToSettings={() =>
            navigation.navigate({ surface: 'workbench.settings', params: { page: 'models.catalog' } })
          }
        />
      ),
      useVisible: () => useUnconfiguredVisible(api),
    })
  },
})
