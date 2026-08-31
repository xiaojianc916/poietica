import { commands } from '@poietica/contract'
import type { AppSettings, SettingsStore } from '@poietica/settings'

export function createSettingsStore(): SettingsStore {
  let current: AppSettings | undefined
  let pending: Promise<AppSettings> | undefined
  let generation = 0

  const load = (): Promise<AppSettings> => {
    if (current !== undefined) {
      return Promise.resolve(current)
    }
    if (pending !== undefined) {
      return pending
    }

    const startedAt = generation
    pending = commands.settingsGet().then(
      (loaded) => {
        if (generation === startedAt) {
          current = loaded
        }
        return current ?? loaded
      },
      (error: unknown) => {
        throw error
      },
    )

    void pending.finally(() => {
      pending = undefined
    })
    return pending
  }

  return {
    load,

    async save(settings) {
      await commands.settingsSet(settings)
      generation += 1
      current = settings
    },

    async reset() {
      const settings = await commands.settingsReset()
      generation += 1
      current = settings
      return settings
    },
  }
}
