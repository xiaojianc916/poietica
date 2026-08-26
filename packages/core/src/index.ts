export type { DiagnosticLogEntry } from './diagnostics/buffer'
export {
  clearDiagnosticLogs,
  formatDiagnosticLogs,
  getRecentLogEntries,
} from './diagnostics/buffer'
export type { LogContext, LogLevel } from './diagnostics/log'
export { error, log, warn } from './diagnostics/log'
export { assertUnreachable } from './errors'
export {
  createExternalStore,
  type ExternalStore,
  type ExternalStoreSource,
} from './external-store'
export {
  type ClassifiedFailure,
  type ClassifiedFailureInput,
  createClassifiedFailure,
  createFailureScopeKey,
  type FailureImpact,
  type FailureRecovery,
  type FailureScope,
  isTerminalFailureImpact,
  type NonTerminalFailureImpact,
  type TerminalFailureImpact,
} from './failure-kernel'
export { optionalProperty } from './optional-property'
export {
  createPreference,
  type Preference,
  type PreferenceFailure,
  type PreferenceSource,
} from './preference'
export {
  isProjectlessWorkspaceRoot,
  normalizeWorkspaceRoot,
  workspaceRootName,
} from './workspace-root'
