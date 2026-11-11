import type { CoreModule, RetiredCoreModule } from '@poietica/core-kernel'
import agentSettings from '@poietica/feature-agent-settings/core'
import attachments from '@poietica/feature-attachments/core'
import automations from '@poietica/feature-automations/core'
import browser from '@poietica/feature-browser/core'
import checkpoints from '@poietica/feature-checkpoints/core'
import conversation from '@poietica/feature-conversation/core'
import extensions from '@poietica/feature-extensions/core'
import files from '@poietica/feature-files/core'
import intelligentUi from '@poietica/feature-intelligent-ui/core'
import journal from '@poietica/feature-journal/core'
import models from '@poietica/feature-models/core'
import platform from '@poietica/feature-platform/core'
import policy from '@poietica/feature-policy/core'
import python from '@poietica/feature-python/core'
import review from '@poietica/feature-review/core'
import usage from '@poietica/feature-usage/core'
import workbuddy from '@poietica/feature-workbuddy/core'
import workspaces from '@poietica/feature-workspaces/core'

/**
 * Core 的功能模块清单。这是唯一的装配点；顺序无关（内核按 dependsOn 拓扑排序）。
 */
export const coreModules: readonly CoreModule[] = [
  platform,
  policy,
  checkpoints,
  workspaces,
  attachments,
  models,
  agentSettings,
  conversation,
  usage,
  review,
  files,
  extensions,
  python,
  automations,
  browser,
  intelligentUi,
  journal,
  workbuddy,
]

/**
 * 已从产品移除、启动时要清掉数据的模块（只增不减：一条记录至少保留到所有用户都升级过一次）。
 * 目前没有退役模块。
 */
export const retiredCoreModules: readonly RetiredCoreModule[] = []
