import type { CoreModule } from '@poietica/core-kernel'
import agentSettings from '@poietica/feature-agent-settings/core'
import attachments from '@poietica/feature-attachments/core'
import automations from '@poietica/feature-automations/core'
import conversation from '@poietica/feature-conversation/core'
import extensions from '@poietica/feature-extensions/core'
import models from '@poietica/feature-models/core'
import platform from '@poietica/feature-platform/core'
import python from '@poietica/feature-python/core'
import review from '@poietica/feature-review/core'
import usage from '@poietica/feature-usage/core'
import workspaces from '@poietica/feature-workspaces/core'

/**
 * Core 的功能模块清单。这是唯一的装配点；顺序无关（内核按 dependsOn 拓扑排序）。
 */
export const coreModules: readonly CoreModule[] = [
  platform,
  workspaces,
  attachments,
  models,
  agentSettings,
  conversation,
  usage,
  review,
  extensions,
  python,
  automations,
]
