// 由 tooling/assembly/contracts.ts 生成；不要手改。

import type { Contract } from '@poietica/contract-kit'
import { agentSettingsContract } from '@poietica/feature-agent-settings/contract'
import { attachmentsContract } from '@poietica/feature-attachments/contract'
import { automationsContract } from '@poietica/feature-automations/contract'
import { browserContract } from '@poietica/feature-browser/contract'
import { checkpointsContract } from '@poietica/feature-checkpoints/contract'
import { conversationContract } from '@poietica/feature-conversation/contract'
import { extensionsContract } from '@poietica/feature-extensions/contract'
import { filesContract } from '@poietica/feature-files/contract'
import { intelligentUiContract } from '@poietica/feature-intelligent-ui/contract'
import { modelsContract } from '@poietica/feature-models/contract'
import { platformContract } from '@poietica/feature-platform/contract'
import { policyContract } from '@poietica/feature-policy/contract'
import { preferencesContract } from '@poietica/feature-preferences/contract'
import { pythonContract } from '@poietica/feature-python/contract'
import { reviewContract } from '@poietica/feature-review/contract'
import { secretsContract } from '@poietica/feature-secrets/contract'
import { settingsContract } from '@poietica/feature-settings/contract'
import { terminalContract } from '@poietica/feature-terminal/contract'
import { updateContract } from '@poietica/feature-update/contract'
import { usageContract } from '@poietica/feature-usage/contract'
import { workbuddyContract } from '@poietica/feature-workbuddy/contract'
import { workspacesContract } from '@poietica/feature-workspaces/contract'

export const featureContracts = [
  agentSettingsContract,
  attachmentsContract,
  automationsContract,
  browserContract,
  checkpointsContract,
  conversationContract,
  extensionsContract,
  filesContract,
  intelligentUiContract,
  modelsContract,
  platformContract,
  policyContract,
  preferencesContract,
  pythonContract,
  reviewContract,
  secretsContract,
  settingsContract,
  terminalContract,
  updateContract,
  usageContract,
  workbuddyContract,
  workspacesContract,
] as const satisfies readonly Contract[]
