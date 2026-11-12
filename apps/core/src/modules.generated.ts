// 由 tooling/assembly/core-modules.ts 生成；不要手改。

import type { CoreModule, ModuleKind } from '@poietica/core-kernel'
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
import settings from '@poietica/feature-settings/core'
import usage from '@poietica/feature-usage/core'
import workbuddy from '@poietica/feature-workbuddy/core'
import workspaces from '@poietica/feature-workspaces/core'

export const coreModuleKinds = {
  'agent-settings': 'domain',
  attachments: 'domain',
  automations: 'domain',
  browser: 'domain',
  checkpoints: 'domain',
  conversation: 'domain',
  extensions: 'domain',
  files: 'domain',
  'intelligent-ui': 'agent-tool',
  journal: 'domain',
  models: 'domain',
  platform: 'domain',
  policy: 'domain',
  python: 'integration',
  review: 'domain',
  settings: 'domain',
  usage: 'domain',
  workbuddy: 'integration',
  workspaces: 'domain',
} as const satisfies Record<string, ModuleKind>

export const coreModules: readonly CoreModule[] = [
  agentSettings,
  attachments,
  automations,
  browser,
  checkpoints,
  conversation,
  extensions,
  files,
  intelligentUi,
  journal,
  models,
  platform,
  policy,
  python,
  review,
  settings,
  usage,
  workbuddy,
  workspaces,
]
