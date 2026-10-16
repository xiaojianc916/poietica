import type { ThreadId } from './address'
import type { SessionGoal } from './goal'

export type SessionConfigPurpose = 'model' | 'thought' | 'permission' | 'mode' | 'other'

export interface SessionConfigChoice {
  readonly value: string
  readonly label: string
  readonly detail?: string | undefined
}

export interface SessionConfigControl {
  readonly id: string
  readonly label: string
  readonly detail?: string | undefined
  readonly purpose: SessionConfigPurpose
  readonly appliesOnSubmit?: true
  readonly current: string
  readonly choices: readonly SessionConfigChoice[]
}

export interface SessionConfigReport {
  readonly sessionId: string
  readonly controls: readonly SessionConfigControl[]
  readonly goal: SessionGoal | null
}

export interface SessionConfigPort {
  readonly select: (
    threadId: ThreadId,
    configId: string,
    value: string,
    input?: string,
  ) => Promise<readonly SessionConfigControl[]>
  readonly subscribe: (handler: (report: SessionConfigReport) => void) => () => void
}
