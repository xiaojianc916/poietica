/// <reference path="../../../../packages/design-system/src/css.d.ts" />
import { builtinPoints, defineUiFeature, SETTINGS_GROUPS } from '@poietica/ui-kernel'
import { Brain, Monitor, Wand } from 'lucide-react'
import { AgentPage } from './agent-page'
import { createAgentSettingsApi } from './api'
import { CapabilitiesPage } from './capabilities-page'

export default defineUiFeature({
  id: 'agent-settings',
  setup(ctx) {
    const api = createAgentSettingsApi(ctx)

    /*
     * 设置导航的三页，**标题与图标取 legacy**（外观的正本）：记忆（Brain）/ 个性化（Wand）/
     * 电脑控制（Monitor）。数据的读法按新架构：三页读同一份 `agentSettings.catalog`
     * （引擎端口一次给全，04 页 §3.8），各自只画自己那一段 —— legacy 的 memory / persona
     * 两页共用一个目录 store，这里同此（sectionEntries 换成 belongsTo）。
     */
    ctx.contribute(builtinPoints.settingsPages, {
      id: 'agent-settings.memory',
      group: SETTINGS_GROUPS.agent,
      order: 400,
      title: '记忆',
      icon: Brain,
      component: () => <AgentPage api={api} section="memory" />,
    })

    ctx.contribute(builtinPoints.settingsPages, {
      id: 'agent-settings.persona',
      group: SETTINGS_GROUPS.agent,
      order: 410,
      title: '个性化',
      icon: Wand,
      component: () => <AgentPage api={api} section="persona" />,
    })

    ctx.contribute(builtinPoints.settingsPages, {
      id: 'agent-settings.capabilities',
      // 段内次序照 legacy：… 快捷键（530）→ 电脑控制（540）→ 用量（700）→ 已归档（710）
      group: SETTINGS_GROUPS.agent,
      order: 540,
      title: '电脑控制',
      icon: Monitor,
      component: () => <CapabilitiesPage api={api} />,
    })
  },
})
