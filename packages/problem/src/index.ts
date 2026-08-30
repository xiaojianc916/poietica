/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */
export type { DiagnosticLogEntry } from './diagnostics/buffer.ts'
export {
  formatDiagnosticLogs,
  getRecentLogEntries,
  normalizeOptionalText,
  normalizeText,
  redactText,
  safeStringify,
  sanitizeContext,
} from './diagnostics/buffer.ts'
export type { LogContext, LogLevel } from './diagnostics/log.ts'
export { error, warn } from './diagnostics/log.ts'
export { assertInvariant, assertUnreachable } from './errors.ts'
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
} from './failure-kernel.ts'
export { isRecord } from './is-record.ts'
export { optionalProperty } from './optional-property.ts'
export { isProblem, type Problem, ProblemError, sentence } from './problem.ts'
