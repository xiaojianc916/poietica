import { commands } from '@poietica/contract'
import type { AppSettings, SettingsStore } from '@poietica/settings'
import { throughIpc } from '../error'

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
    const request = throughIpc(() => commands.settingsGet()).then((loaded) => {
      if (generation === startedAt) {
        current = loaded
      }

      return current ?? loaded
    })

    pending = request
    const clear = (): void => {
      if (pending === request) {
        pending = undefined
      }
    }
    void request.then(clear, clear)
    return request
  }

  return {
    load,

    async save(settings) {
      await throughIpc(() => commands.settingsSet(settings))
      generation += 1
      current = settings
    },

    async reset() {
      const settings = await throughIpc(() => commands.settingsReset())
      generation += 1
      current = settings
      return settings
    },
  }
}
