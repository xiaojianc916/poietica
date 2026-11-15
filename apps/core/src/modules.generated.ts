// 由 tooling/assembly/core-modules.ts 生成；不要手改。

import type { CoreModule, CoreModuleDescriptor } from '@poietica/core-kernel'
import agentSettings from '@poietica/feature-agent-settings/core'
import attachments from '@poietica/feature-attachments/core'
import audit from '@poietica/feature-audit/core'
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
import runs from '@poietica/feature-runs/core'
import settings from '@poietica/feature-settings/core'
import threads from '@poietica/feature-threads/core'
import timeline from '@poietica/feature-timeline/core'
import usage from '@poietica/feature-usage/core'
import workbuddy from '@poietica/feature-workbuddy/core'
import workspaces from '@poietica/feature-workspaces/core'

export interface FeatureDescriptor extends CoreModuleDescriptor {
  readonly hasContract: boolean
}

export const featureDescriptors = {
  'agent-settings': {
    id: 'agent-settings',
    kind: 'domain',
    tier: 4,
    processes: ['core', 'ui'],
    hasContract: true,
    module: agentSettings,
  },
  attachments: {
    id: 'attachments',
    kind: 'domain',
    tier: 2,
    processes: ['core', 'host', 'ui'],
    hasContract: true,
    module: attachments,
  },
  audit: {
    id: 'audit',
    kind: 'domain',
    tier: 4,
    processes: ['core'],
    hasContract: true,
    module: audit,
  },
  automations: {
    id: 'automations',
    kind: 'domain',
    tier: 4,
    processes: ['core', 'ui'],
    hasContract: true,
    module: automations,
  },
  browser: {
    id: 'browser',
    kind: 'domain',
    tier: 4,
    processes: ['core', 'host', 'ui'],
    hasContract: true,
    module: browser,
  },
  checkpoints: {
    id: 'checkpoints',
    kind: 'domain',
    tier: 1,
    processes: ['core'],
    hasContract: true,
    module: checkpoints,
  },
  conversation: {
    id: 'conversation',
    kind: 'domain',
    tier: 3,
    processes: ['core', 'host', 'ui'],
    hasContract: true,
    module: conversation,
  },
  extensions: {
    id: 'extensions',
    kind: 'domain',
    tier: 4,
    processes: ['core', 'ui'],
    hasContract: true,
    module: extensions,
  },
  files: {
    id: 'files',
    kind: 'domain',
    tier: 4,
    processes: ['core', 'host', 'ui'],
    hasContract: true,
    module: files,
  },
  'intelligent-ui': {
    id: 'intelligent-ui',
    kind: 'agent-tool',
    tier: 4,
    processes: ['core', 'host', 'ui'],
    hasContract: true,
    module: intelligentUi,
  },
  journal: {
    id: 'journal',
    kind: 'domain',
    tier: 1,
    processes: ['core'],
    hasContract: false,
    module: journal,
  },
  models: {
    id: 'models',
    kind: 'domain',
    tier: 2,
    processes: ['core', 'ui'],
    hasContract: true,
    module: models,
  },
  platform: {
    id: 'platform',
    kind: 'domain',
    tier: 0,
    processes: ['core', 'host', 'ui'],
    hasContract: true,
    module: platform,
  },
  policy: {
    id: 'policy',
    kind: 'domain',
    tier: 1,
    processes: ['core'],
    hasContract: true,
    module: policy,
  },
  python: {
    id: 'python',
    kind: 'integration',
    tier: 4,
    processes: ['core', 'ui'],
    hasContract: true,
    module: python,
  },
  review: {
    id: 'review',
    kind: 'domain',
    tier: 4,
    processes: ['core', 'ui'],
    hasContract: true,
    module: review,
  },
  runs: {
    id: 'runs',
    kind: 'domain',
    tier: 1,
    processes: ['core'],
    hasContract: false,
    module: runs,
  },
  settings: {
    id: 'settings',
    kind: 'domain',
    tier: 0,
    processes: ['core'],
    hasContract: true,
    module: settings,
  },
  threads: {
    id: 'threads',
    kind: 'domain',
    tier: 1,
    processes: ['core'],
    hasContract: false,
    module: threads,
  },
  timeline: {
    id: 'timeline',
    kind: 'domain',
    tier: 1,
    processes: ['core'],
    hasContract: false,
    module: timeline,
  },
  usage: {
    id: 'usage',
    kind: 'domain',
    tier: 4,
    processes: ['core', 'ui'],
    hasContract: true,
    module: usage,
  },
  workbuddy: {
    id: 'workbuddy',
    kind: 'integration',
    tier: 4,
    processes: ['core', 'ui'],
    hasContract: true,
    module: workbuddy,
  },
  workspaces: {
    id: 'workspaces',
    kind: 'domain',
    tier: 1,
    processes: ['core', 'ui'],
    hasContract: true,
    module: workspaces,
  },
} as const satisfies Record<string, FeatureDescriptor>

export const coreModules: readonly CoreModule[] = Object.values(featureDescriptors).map(
  (descriptor) => descriptor.module,
)
