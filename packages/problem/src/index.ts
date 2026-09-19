/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */
export { safeStringify } from './diagnostics/buffer.ts'
export { error, warn } from './diagnostics/log.ts'
export { assertUnreachable } from './errors.ts'
export {
  FailureCoordinator,
  type FailureIncident,
  type FailureSignal,
  failureCoordinator,
  type TerminalFailureIncident,
} from './failure-coordinator.ts'
export { formatFailureDiagnostic } from './failure-diagnostic.ts'
export type {
  FailureImpact,
  FailureRecovery,
  FailureScope,
  TerminalFailureImpact,
} from './failure-kernel.ts'
export { isRecord } from './is-record.ts'
export { optionalProperty } from './optional-property.ts'
export { isProblem, ProblemError } from './problem.ts'
