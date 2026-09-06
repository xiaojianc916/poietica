import { createExternalStore } from '@poietica/external-store'

export interface ConversationEntrySnapshot {
  readonly threadId: string
  readonly started: boolean
}
interface Dependencies {
  readonly createId: () => string
  readonly readRoot: () => string | null
  readonly createProjectless: () => Promise<string>
  readonly open: (threadId: string, root: string) => Promise<string | null>
}
export type ConversationEntry = ReturnType<typeof createConversationEntry>

export function createConversationEntry(input: Dependencies) {
  let revision = 0
  let disposed = false
  let pending: Promise<boolean> | null = null
  let projectless: string | null = null
  let snapshot: ConversationEntrySnapshot = Object.freeze({
    threadId: input.createId(),
    started: false,
  })
  const store = createExternalStore({ read: () => snapshot })
  return {
    subscribe: store.subscribe,
    getSnapshot: store.read,
    begin: (): void => {
      if (disposed) {
        return
      }
      revision += 1
      pending = null
      projectless = null
      snapshot = Object.freeze({ threadId: input.createId(), started: false })
      store.notify()
    },
    prepare: (): Promise<boolean> => {
      if (disposed) {
        return Promise.resolve(false)
      }
      if (snapshot.started) {
        return Promise.resolve(true)
      }
      if (pending !== null) {
        return pending
      }
      const ticket = revision
      const threadId = snapshot.threadId
      const selectedRoot = input.readRoot()
      const attempt = Promise.resolve()
        .then(async () => {
          if (disposed || ticket !== revision) {
            return false
          }
          let root = selectedRoot
          if (root === null) {
            root = projectless ?? (await input.createProjectless())
            if (disposed || ticket !== revision) {
              return false
            }
            projectless = root
          }
          const opened = await input.open(threadId, root)
          if (disposed || ticket !== revision || opened === null) {
            return false
          }
          if (opened !== threadId) {
            throw new Error('Conversation creation returned a different identity.')
          }
          snapshot = Object.freeze({ threadId, started: true })
          store.notify()
          return true
        })
        .finally(() => {
          if (pending === attempt) {
            pending = null
          }
        })
      pending = attempt
      return attempt
    },
    dispose: (): void => {
      disposed = true
      revision += 1
      pending = null
    },
  }
}
