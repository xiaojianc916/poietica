import { commands } from '@poietica/contract'
import type { SettingsPersistence } from '@poietica/settings'
import { throughIpc } from './ipc-error'
export function createSettingsPersistence(): SettingsPersistence {
  return {
    read: () => throughIpc(() => commands.settingsGet()),
    save: (settings) => throughIpc(() => commands.settingsSet(settings)),
    reset: () => throughIpc(() => commands.settingsReset()),
  }
}
