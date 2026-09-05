import type {
  AgentCapabilityPort,
  AgentSessionPort,
  PermissionPosturePort,
  SessionConfigPort,
  SessionUsagePort,
  ThreadPort,
} from '../agent'
import { AgentCapabilityStore } from './agent-capability-store'
import { type SessionControlsFailureReport, SessionControlsStore } from './session-controls-store'
import { ThreadsStore } from './threads-store'
import { TranscriptStore } from './transcript-store'

type Dependencies = {
  readonly session: AgentSessionPort
  readonly threads: ThreadPort
  readonly config: SessionConfigPort
  readonly usage: SessionUsagePort
  readonly posture: PermissionPosturePort
  readonly capabilities: AgentCapabilityPort
  readonly workspace: {
    readonly read: () => string | null
    readonly ready: () => Promise<unknown>
    readonly subscribe: (listener: () => void) => () => void
  }
  readonly report: {
    readonly session: SessionControlsFailureReport
    readonly capability: {
      readonly readFailed: (cause: unknown) => void
      readonly changeFailed: (cause: unknown) => void
    }
    readonly workspace: (cause: unknown) => void
  }
}

export type ConversationRuntime = ReturnType<typeof createConversationRuntime>

/** Owns application-scoped conversation services, independently of the React tree. */
export function createConversationRuntime(input: Dependencies) {
  const transcripts = new TranscriptStore()
  const controls = new SessionControlsStore({
    config: input.config,
    port: input.threads,
    posture: input.posture,
    report: input.report.session,
    transcripts,
    usage: input.usage,
  })
  const threads = new ThreadsStore({
    defaultWorkspaceId: input.workspace.read,
    port: input.threads,
  })
  const capabilities = new AgentCapabilityStore({
    posture: input.posture,
    report: input.report.capability,
  })
  const releases: Array<() => void> = []
  let started = false
  let disposed = false
  let ready = false

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    const failures: unknown[] = []
    for (const release of [
      ...releases.splice(0).reverse(),
      controls.dispose,
      threads.dispose,
      transcripts.dispose,
    ]) {
      try {
        release()
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Conversation services did not all stop cleanly.')
    }
  }

  return {
    transcripts,
    controls,
    threads,
    capabilities,
    dispose,
    start(): void {
      if (disposed) {
        throw new Error('Conversation runtime is disposed.')
      }
      if (started) {
        return
      }
      started = true
      try {
        transcripts.ensure(input.session)
        releases.push(threads.onOpened(controls.opened))
        releases.push(
          threads.onRemoved((threadId) => {
            controls.forget(threadId)
            transcripts.forget(threadId)
          }),
        )
        releases.push(controls.start())
        releases.push(capabilities.start(input.capabilities))
        releases.push(
          input.workspace.subscribe(() => {
            if (!disposed && ready) {
              void threads.refresh()
            }
          }),
        )
        void input.workspace.ready().then(
          () => {
            if (!disposed) {
              ready = true
              void threads.refresh()
            }
          },
          (cause: unknown) => {
            if (!disposed) {
              input.report.workspace(cause)
            }
          },
        )
      } catch (cause) {
        try {
          dispose()
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Conversation startup and cleanup failed.')
        }
        throw cause
      }
    },
  }
}
