import agentSettings from '@poietica/feature-agent-settings/ui'
import attachments from '@poietica/feature-attachments/ui'
import automations from '@poietica/feature-automations/ui'
import browser from '@poietica/feature-browser/ui'
import conversation from '@poietica/feature-conversation/ui'
import extensions from '@poietica/feature-extensions/ui'
import models from '@poietica/feature-models/ui'
import platform from '@poietica/feature-platform/ui'
import preferences from '@poietica/feature-preferences/ui'
import python from '@poietica/feature-python/ui'
import review from '@poietica/feature-review/ui'
import terminal from '@poietica/feature-terminal/ui'
import update from '@poietica/feature-update/ui'
import usage from '@poietica/feature-usage/ui'
import workspaces from '@poietica/feature-workspaces/ui'
import { builtinPoints, defineUiFeature, NavigationToken, type UiFeature } from '@poietica/ui-kernel'
import { lazy } from 'react'

const DesignSystemDemo = lazy(() => import('./design-system-demo').then((m) => ({ default: m.DesignSystemDemo })))

/**
 * 开发版的组件演示页（P3.4 的验收工具，13 页 §4），路由 `/__ds`。
 * 只在 dev 注册；安装版里这段（含下面那个动态 import 的目标）不会出现在产物中。
 */
const designSystemDemo: UiFeature = defineUiFeature({
  id: 'design-system-demo',
  setup(ctx) {
    ctx.contribute(builtinPoints.surfaces, {
      id: 'design-system.demo',
      title: '组件演示',
      component: DesignSystemDemo,
    })

    /*
     * `#/__ds` 在 Core ready 之后**再**认一次。
     *
     * preferences 在 core ready 时按 uiState 恢复上次的导航（那是它的职责），而
     * `#/__ds` 是开发期的直达链接，比记忆优先 —— design-system-demo 的 setup 排在
     * preferences 之后，所以这里的一次 navigate 正好压在恢复之上。生产版没有这个功能。
     */
    ctx.lifecycle.onCoreReady(() => {
      if (window.location.hash !== '#/__ds') return
      ctx.services.get(NavigationToken).navigate({ surface: 'design-system.demo', params: {} })
    })
    // 命令面板里也能到（比记 #/__ds 好用）；同时说明这个页面只是开发期的验收工具
    ctx.contribute(builtinPoints.commands, {
      id: 'design-system.openDemo',
      title: '组件演示（开发）',
      category: '开发',
      run: () => {
        window.location.hash = '#/__ds'
        ctx.services.get(NavigationToken).navigate({ surface: 'design-system.demo', params: {} })
      },
    })
  },
})

/**
 * UI 功能清单。顺序无关（内核按 dependsOn 拓扑排序）。
 * workbenchFeature 由 main.tsx 加入（它是外壳本身，不属于功能清单）。
 *
 * P5 的 attachments 依赖 conversation 的 ui-api，因此排在 conversation 之后（内核也会按
 * dependsOn 拓扑排序，这里的次序只是为了读起来顺）。
 */
export const uiFeatures: readonly UiFeature[] = [
  platform,
  preferences,
  workspaces,
  models,
  agentSettings,
  conversation,
  attachments,
  usage,
  review,
  terminal,
  browser,
  automations,
  update,
  extensions,
  python,
  ...(import.meta.env.DEV ? [designSystemDemo] : []),
]
