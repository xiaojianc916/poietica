// 由 tooling/assembly/process-modules.ts 生成；不要手改。

import attachments from '@poietica/feature-attachments/host'
import browser from '@poietica/feature-browser/host'
import conversation from '@poietica/feature-conversation/host'
import files from '@poietica/feature-files/host'
import intelligentUi from '@poietica/feature-intelligent-ui/host'
import platform from '@poietica/feature-platform/host'
import preferences from '@poietica/feature-preferences/host'
import secrets from '@poietica/feature-secrets/host'
import terminal from '@poietica/feature-terminal/host'
import update from '@poietica/feature-update/host'
import type { HostModule } from '@poietica/host-kernel'

export const hostModules: readonly HostModule[] = [
  attachments,
  browser,
  conversation,
  files,
  intelligentUi,
  platform,
  preferences,
  secrets,
  terminal,
  update,
]
