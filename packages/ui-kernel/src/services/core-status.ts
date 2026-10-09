import { createValue, type Observable } from './observable'

export interface CoreStatus {
  readonly state: 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'
  readonly reason:
    | 'start_timeout'
    | 'crashed'
    | 'crash_loop'
    | 'isolation_violated'
    | 'bad_arguments'
    | 'protocol_mismatch'
    | 'core_missing'
    | null
  readonly attempt: number
}

export interface CoreStatusService extends Observable<CoreStatus> {
  set(s: CoreStatus): void
}

export function createCoreStatusService(): CoreStatusService {
  return createValue<CoreStatus>({ state: 'starting', reason: null, attempt: 0 })
}
