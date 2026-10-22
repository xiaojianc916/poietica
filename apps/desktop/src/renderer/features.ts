import agentSettings from '@poietica/feature-agent-settings/ui'
import attachments from '@poietica/feature-attachments/ui'
import automations from '@poietica/feature-automations/ui'
import browser from '@poietica/feature-browser/ui'
import conversation from '@poietica/feature-conversation/ui'
import extensions from '@poietica/feature-extensions/ui'
import files from '@poietica/feature-files/ui'
import intelligentUi from '@poietica/feature-intelligent-ui/ui'
import models from '@poietica/feature-models/ui'
import platform from '@poietica/feature-platform/ui'
import preferences from '@poietica/feature-preferences/ui'
import python from '@poietica/feature-python/ui'
import review from '@poietica/feature-review/ui'
import terminal from '@poietica/feature-terminal/ui'
import update from '@poietica/feature-update/ui'
import usage from '@poietica/feature-usage/ui'
import workspaces from '@poietica/feature-workspaces/ui'
import type { UiFeature } from '@poietica/ui-kernel'

/**
 * UI 功能清单。顺序无关（内核按 dependsOn 拓扑排序）。
 * workbenchFeature 由 main.tsx 加入（它是外壳本身，不属于功能清单）。
 *
 * 次序按功能分级（tooling/depcruise/feature-tiers.json）从底往上排，只是为了读起来顺：
 * attachments 在 conversation 之前（conversation 的 UI 依赖它的 ui-api），插件在最后。
 */
export const uiFeatures: readonly UiFeature[] = [
  platform,
  preferences,
  workspaces,
  models,
  agentSettings,
  attachments,
  conversation,
  usage,
  review,
  files,
  terminal,
  browser,
  automations,
  update,
  extensions,
  python,
  intelligentUi,
]
