import { normalizeWorkspaceRoot } from '@poietica/conversation'
import type { Preference } from '@poietica/external-store'

export interface WorkspaceRoots {
  readonly readActive: () => string | null
  readonly fallbackActive: () => string | null
  readonly subscribeActive: (listen: () => void) => () => void
  readonly setActive: (value: string | null) => void
  readonly readDefault: () => string | null
  readonly subscribeDefault: (listen: () => void) => () => void
  readonly start: () => Promise<string | null>
  readonly ready: () => Promise<string | null>
  readonly dispose: () => void
}

export function createWorkspaceRoots(dependencies: {
  readonly active: Preference<string | null>
  readonly home: Preference<string | null>
  readonly readHome: () => Promise<string>
  readonly onHomeFailure: (cause: unknown) => void
}): WorkspaceRoots {
  const { active, home, readHome, onHomeFailure } = dependencies
  let disposed = false
  let verification: Promise<string | null> | null = null
  const start = (): Promise<string | null> => {
    if (disposed) {
      return Promise.resolve(home.read())
    }
    verification ??= Promise.resolve().then(async () => {
      if (disposed) {
        return home.read()
      }
      try {
        const directory = await readHome()
        if (!disposed) {
          home.write(normalizeWorkspaceRoot(directory))
        }
      } catch (cause) {
        if (!disposed) {
          onHomeFailure(cause)
        }
      }
      return home.read()
    })
    return verification
  }
  return {
    readActive: active.read,
    fallbackActive: active.readFallback,
    subscribeActive: active.subscribe,
    setActive: (value) => {
      if (!disposed) {
        active.write(value === null || value.length === 0 ? null : normalizeWorkspaceRoot(value))
      }
    },
    readDefault: home.read,
    subscribeDefault: home.subscribe,
    start,
    ready: () => {
      const pending = start()
      const cached = home.read()
      return cached === null ? pending : Promise.resolve(cached)
    },
    dispose: () => {
      disposed = true
    },
  }
}
