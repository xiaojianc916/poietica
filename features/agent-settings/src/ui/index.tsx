import { builtinPoints, defineUiFeature, SETTINGS_GROUPS } from '@poietica/ui-kernel'
import { Brain, Monitor, Wand } from 'lucide-react'
import { AgentPage } from './agent-page'
import { createAgentSettingsApi } from './api'
import { CapabilitiesPage } from './capabilities-page'

export default defineUiFeature({
  id: 'agent-settings',
  setup(ctx) {
    const api = createAgentSettingsApi(ctx)

    /* 三页的标题与图标取 legacy：记忆（Brain）/ 个性化（Wand）/ 电脑控制（Monitor）。三页读同一份 `agentSettings.catalog`，各自只画自己
     * 那一段。 */
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
      group: SETTINGS_GROUPS.agent,
      order: 540,
      title: '电脑控制',
      icon: Monitor,
      component: () => <CapabilitiesPage api={api} />,
    })
  },
})
