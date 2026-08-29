export type { DiagnosticLogEntry } from './diagnostics/buffer'
export {
  formatDiagnosticLogs,
  getRecentLogEntries,
  normalizeOptionalText,
  normalizeText,
  redactText,
  safeStringify,
  sanitizeContext,
} from './diagnostics/buffer'
export type { LogContext, LogLevel } from './diagnostics/log'
export { error, warn } from './diagnostics/log'
export { assertUnreachable } from './errors'
export { createExternalStore } from './external-store'
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
export { isRecord } from './is-record'
export { optionalProperty } from './optional-property'
export {
  createPreference,
  type Preference,
  type PreferenceFailure,
} from './preference'
export {
  isProjectlessWorkspaceRoot,
  normalizeWorkspaceRoot,
  workspaceRootName,
} from './workspace-root'
