import { createPreference } from '@poietica/external-store'
import { warn } from '@poietica/problem'

export type WorkspaceCollapse = ReturnType<typeof createWorkspaceCollapse>
export function createWorkspaceCollapse() {
  const empty: ReadonlySet<string> = new Set()
  const collapsed = createPreference<ReadonlySet<string>>({
    key: 'poietica.threads.collapsedWorkspaces',
    fallback: empty,
    decode: (raw) => {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? new Set(parsed.filter((id) => typeof id === 'string')) : empty
    },
    encode: (value) => JSON.stringify([...value]),
    onFailure: ({ stage, cause }) => {
      warn(stage === 'read' ? '读不出工作区折叠偏好' : '写不进工作区折叠偏好', {
        scope: 'workspace-collapse',
        cause,
      })
    },
  })
  return {
    read: collapsed.read,
    readFallback: collapsed.readFallback,
    subscribe: collapsed.subscribe,
    toggle: (id: string): void => {
      const next = new Set(collapsed.read())
      if (!next.delete(id)) {
        next.add(id)
      }
      collapsed.write(next)
    },
  }
}
