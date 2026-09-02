import { commands } from '@poietica/contract'
import type { AppSettings, SettingsStore } from '@poietica/settings'
import { throughIpc } from '../error'

export function createSettingsStore(): SettingsStore {
  let current: AppSettings | undefined
  let pending: Promise<AppSettings> | undefined
  let generation = 0
  const listeners = new Set<() => void>()

  const publish = (settings: AppSettings): void => {
    generation += 1
    current = settings
    for (const listener of listeners) {
      listener()
    }
  }

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
        publish(loaded)
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
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    async save(settings) {
      await throughIpc(() => commands.settingsSet(settings))
      publish(settings)
    },
    async reset() {
      const settings = await throughIpc(() => commands.settingsReset())
      publish(settings)
      return settings
    },
  }
}
