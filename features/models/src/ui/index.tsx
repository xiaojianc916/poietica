/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { builtinPoints, defineUiFeature, NavigationToken, SETTINGS_GROUPS } from '@poietica/ui-kernel'
import { Cpu } from 'lucide-react'
import { createModelsApi } from './api'
import { ModelsPage } from './models-page'
import './models-settings.css'
import { ModelsBanner, useUnconfiguredVisible } from './unconfigured-banner'

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

    /*
     * 未配置提示（07 页 §6E 的文案与动作）：没有任何 configured 的服务商时显示 + 「去设置」。
     *
     * 落点按产品负责人的要求放在**新对话界面的吉祥物上方**（不占独立一行），因此走
     * entryNotices —— 两条判据、文案、动作一字未变，只是画在哪里不同。
     */
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
