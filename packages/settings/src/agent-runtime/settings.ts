import { agent, resolveAgentProfile } from '@poietica/agent-catalog'
import type { AgentConfigSnapshot, AgentSettings } from './model'
import type { AgentConfigurationRepository } from './repository'
export function createAgentSettings(
  repository: AgentConfigurationRepository,
): AgentSettings & { readonly dispose: () => void } {
  let loading: Promise<AgentConfigSnapshot> | undefined
  let disposed = false
  const requireActive = (): void => {
    if (disposed) {
      throw new DOMException('Agent settings are disposed.', 'AbortError')
    }
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
    dispose() {
      disposed = true
      loading = undefined
    },
  }
}
