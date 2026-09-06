import { agent, resolveAgentProfile } from '@poietica/agent-catalog'
import type { AgentConfigSnapshot, AgentInstallStatus, AgentSettings } from './model'
import type { AgentConfigurationRepository } from './repository'
export function createAgentSettings(
  repository: AgentConfigurationRepository,
): AgentSettings & { readonly dispose: () => void } {
  const listeners = new Set<() => void>()
  const flights = new Map<string, Promise<AgentInstallStatus>>()
  let loading: Promise<AgentConfigSnapshot> | undefined
  let disposed = false
  const requireActive = (): void => {
    if (disposed) {
      throw new DOMException('Agent settings are disposed.', 'AbortError')
    }
  }
  const singleFlight = (
    key: string,
    work: () => Promise<AgentInstallStatus>,
  ): Promise<AgentInstallStatus> => {
    requireActive()
    const held = flights.get(key)
    if (held !== undefined) {
      return held
    }
    const pending = work()
    flights.set(key, pending)
    const release = (): void => {
      if (flights.get(key) === pending) {
        flights.delete(key)
      }
    }
    void pending.then(release, release)
    return pending
  }
  return {
    load() {
      requireActive()
      if (loading !== undefined) {
        return loading
      }
      const pending = repository.load().then(async (dto) => {
        requireActive()
        const resolved = resolveAgentProfile(dto.agents)
        if (resolved.materialize) {
          const written = await repository.saveAgents([resolved.profile], agent.id)
          requireActive()
          return {
            profile: resolved.profile,
            issues: [...new Set([...dto.issues, ...written.issues, ...resolved.issues])],
          }
        }
        return {
          profile: resolved.profile,
          issues: [...new Set([...dto.issues, ...resolved.issues])],
        }
      })
      loading = pending
      const release = (): void => {
        if (loading === pending) {
          loading = undefined
        }
      }
      void pending.then(release, release)
      return pending
    },
    loadInstallStatus: (id, options) =>
      singleFlight(`status:${id}:${String(options?.force ?? false)}`, () =>
        repository.loadInstallStatus(id, options?.force ?? false),
      ),
    runInstall: (id) => singleFlight(`install:${id}`, () => repository.runInstall(id)),
    notifyConfigChanged() {
      if (!disposed) {
        for (const listener of listeners) {
          listener()
        }
      }
    },
    subscribeConfigChanged(listener) {
      requireActive()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      flights.clear()
      loading = undefined
    },
  }
}
