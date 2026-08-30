import {
  type DiagnosticLogEntry,
  formatDiagnosticLogs,
  getRecentLogEntries,
  normalizeOptionalText,
  normalizeText,
  redactText,
  safeStringify,
  sanitizeContext,
} from './diagnostics/buffer.ts'
import { optionalProperty } from './optional-property.ts'

export interface FailureDiagnosticHint {
  readonly componentStack?: string | null

  readonly source?: string
  readonly line?: number
  readonly column?: number
}

export interface FailureDiagnostic {
  readonly errorName: string
  readonly stack?: string
  readonly componentStack?: string

  readonly source?: string
  readonly line?: number
  readonly column?: number

  readonly pageUrl: string
  readonly userAgent: string

  readonly recentLogs: readonly DiagnosticLogEntry[]
}

interface NormalizedCause {
  readonly name: string
  readonly message: string
  readonly stack?: string
}

const MAX_MESSAGE_LENGTH = 4_000
const MAX_STACK_LENGTH = 32_000

export function normalizeFailureCause(cause: unknown): NormalizedCause {
  if (cause instanceof Error) {
    return {
      name: cause.name || 'Error',

      message: normalizeText(cause.message || 'Unknown error', MAX_MESSAGE_LENGTH),

      ...optionalProperty('stack', normalizeOptionalText(cause.stack, MAX_STACK_LENGTH)),
    }
  }

  if (typeof cause === 'string') {
    return {
      name: 'Error',
      message: normalizeText(cause || 'Unknown error', MAX_MESSAGE_LENGTH),
    }
  }

  const envelope = readEnvelopeMessage(cause)
  if (envelope !== undefined) {
    return {
      name: 'Problem',
      message: normalizeText(envelope, MAX_MESSAGE_LENGTH),
    }
  }
  return {
    name: 'UnknownError',
    message: normalizeText(safeStringify(cause), MAX_MESSAGE_LENGTH),
  }
}

export function createFailureDiagnostic(
  cause: unknown,
  hint: FailureDiagnosticHint = {},
): FailureDiagnostic {
  const normalized = normalizeFailureCause(cause)

  return Object.freeze({
    errorName: normalized.name,

    ...optionalProperty('stack', normalized.stack),

    ...optionalProperty(
      'componentStack',
      normalizeOptionalText(hint.componentStack ?? undefined, MAX_STACK_LENGTH),
    ),

    ...optionalProperty('source', normalizeOptionalText(hint.source, MAX_MESSAGE_LENGTH)),

    ...optionalProperty('line', hint.line),

    ...optionalProperty('column', hint.column),

    pageUrl: redactText(globalThis.location?.href ?? 'unknown'),

    userAgent: redactText(globalThis.navigator?.userAgent ?? 'unknown'),

    recentLogs: getRecentLogEntries(100),
  })
}

export function sanitizeFailureContext(
  context: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
  if (!context) {
    return {}
  }

  return Object.freeze(sanitizeContext(context))
}

export function formatFailureDiagnostic(incident: {
  readonly id: string
  readonly impact: string
  readonly code: string
  readonly occurredAt: string
  readonly technicalMessage: string

  readonly scope: {
    readonly kind: string
  }

  readonly context: Readonly<Record<string, unknown>>

  readonly diagnostic: FailureDiagnostic
}): string {
  const diagnostic = incident.diagnostic

  const contextEntries = Object.entries(incident.context)

  return [
    'Poietica Failure Incident',
    '',
    `Incident ID: ${incident.id}`,

    `时间: ${incident.occurredAt}`,

    `错误码: ${incident.code}`,

    `影响等级: ${incident.impact}`,

    `影响范围: ${incident.scope.kind}`,

    `错误类型: ${diagnostic.errorName}`,

    `错误信息: ${incident.technicalMessage}`,

    diagnostic.source ? `来源: ${diagnostic.source}` : undefined,

    typeof diagnostic.line === 'number' ? `行: ${String(diagnostic.line)}` : undefined,

    typeof diagnostic.column === 'number' ? `列: ${String(diagnostic.column)}` : undefined,

    `页面: ${diagnostic.pageUrl}`,

    `User Agent: ${diagnostic.userAgent}`,

    contextEntries.length > 0
      ? `\n上下文:\n${contextEntries.map(([key, value]) => `${key}: ${String(value)}`).join('\n')}`
      : undefined,

    diagnostic.stack ? `\nJavaScript Stack:\n${diagnostic.stack}` : undefined,

    diagnostic.componentStack
      ? `\nReact Component Stack:\n${diagnostic.componentStack}`
      : undefined,

    diagnostic.recentLogs.length > 0
      ? `\n最近的结构化日志:\n${formatDiagnosticLogs(diagnostic.recentLogs)}`
      : undefined,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
}

/*
 * 跨 IPC 回来的失败是一个信封，不是 Error：整封 stringify 会把 code 与
 * recoverable 一起当成消息推上屏幕。正本是 src-tauri/src/error.rs 的 Problem。
 */
function readEnvelopeMessage(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) {
    return undefined
  }
  const envelope = cause as { readonly code?: unknown; readonly message?: unknown }
  return typeof envelope.code === 'string' && typeof envelope.message === 'string'
    ? envelope.message
    : undefined
}
