export type { DiagnosticLogEntry } from './diagnostics/buffer'
export {
  clearDiagnosticLogs,
  configureDiagnosticBuffer,
  formatDiagnosticLogs,
  getRecentLogEntries,
} from './diagnostics/buffer'
export type { LogContext, LogLevel, LogSink } from './diagnostics/log'
export { error, log, setLogSink, warn } from './diagnostics/log'
export { assertInvariant, assertUnreachable } from './errors'
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
  FAILURE_IMPACTS,
  type FailureImpact,
  type FailureRecovery,
  type FailureScope,
  isNonTerminalFailureImpact,
  isTerminalFailureImpact,
  type NonTerminalFailureImpact,
  type TerminalFailureImpact,
  validateFailurePolicy,
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
