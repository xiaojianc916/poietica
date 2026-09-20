import { isRecord, optionalProperty, safeStringify } from '@poietica/problem'
import type { FailurePhase, TerminalFailureInput } from './fatal-incident'
import { isReactFatalHostMounted, reportFatalIncident } from './fatal-incident'
import { reportFailure } from './problem-presentation'

const BENIGN_MESSAGES = new Set([
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded',
])

export function isBenignWindowError({ message, error }: WindowErrorLike): boolean {
  const candidates = [message, error instanceof Error ? error.message : error]

  return candidates.some(
    (candidate) => typeof candidate === 'string' && BENIGN_MESSAGES.has(candidate.trim()),
  )
}

interface WindowErrorLike {
  readonly message: string
  readonly error: unknown
}

interface ViteHotContext {
  readonly on: (event: string, listener: (payload: unknown) => void) => void
}

interface ParsedViteError {
  readonly error: Error
  readonly source?: string
  readonly line?: number
  readonly column?: number
  readonly context: Readonly<Record<string, unknown>>
}

let installed = false

export function installFatalCollectors(): void {
  if (installed) {
    return
  }

  installed = true

  window.addEventListener('error', handleWindowError, true)

  window.addEventListener('unhandledrejection', handleUnhandledRejection)

  const hot = (
    import.meta as ImportMeta & {
      readonly hot?: ViteHotContext
    }
  ).hot

  hot?.on('poietica:diagnostic', handleViteDiagnostic)
}

function handleWindowError(event: Event): void {
  /* 资源元素加载失败不是 ErrorEvent，也不算应用致命错误。 */
  if (!(event instanceof ErrorEvent)) {
    return
  }

  if (isBenignWindowError(event)) {
    /* Chromium/WebKit 同帧动画布局失效时把 ResizeObserver loop 通知派发进 window.error，与状态丢失无关。 */
    event.preventDefault()
    return
  }

  const capturedError = event.error ?? event.message ?? 'Unhandled window error'

  const location = {
    ...optionalProperty('source', nonEmptyString(event.filename)),
    ...optionalProperty('line', positiveNumber(event.lineno)),
    ...optionalProperty('column', positiveNumber(event.colno)),
  }

  if (isReactFatalHostMounted()) {
    reportFailure('UNHANDLED_WINDOW_ERROR', {
      cause: capturedError,
      collector: 'window-error',
      eventType: event.type,
      ...location,
    })

    return
  }

  const incident = reportFatalIncident({
    impact: 'application-fatal',
    error: capturedError,
    kind: 'bootstrap',
    phase: currentPhase(),
    code: 'FATAL_BOOTSTRAP_WINDOW_ERROR',
    ...location,
    context: {
      collector: 'window-error',
      eventType: event.type,
    },
  })

  emergencyLogIncident(incident)
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  /* 取消不是故障：AbortController.abort() 按 DOM 标准以 AbortError 拒绝。 */
  if (event.reason instanceof DOMException && event.reason.name === 'AbortError') {
    event.preventDefault()
    return
  }

  if (isReactFatalHostMounted()) {
    reportFailure('UNHANDLED_PROMISE_REJECTION', {
      cause: event.reason,
      collector: 'unhandled-rejection',
      eventType: event.type,
    })

    return
  }

  const incident = reportFatalIncident({
    impact: 'application-fatal',
    error: event.reason,
    kind: 'bootstrap',
    phase: currentPhase(),
    code: 'FATAL_BOOTSTRAP_PROMISE_REJECTION',
    context: {
      collector: 'unhandled-rejection',
      eventType: event.type,
    },
  })

  emergencyLogIncident(incident)
}

function handleViteDiagnostic(payload: unknown): void {
  const viteError = parseViteError(payload)

  const input: TerminalFailureInput = {
    impact: 'application-fatal',
    error: viteError.error,
    kind: 'vite',
    phase: currentPhase(),
    code: 'FATAL_VITE_DEVELOPMENT_ERROR',
    ...optionalProperty('source', viteError.source),
    ...optionalProperty('line', viteError.line),
    ...optionalProperty('column', viteError.column),
    context: viteError.context,
  }

  const incident = reportFatalIncident(input)

  emergencyLogIncident(incident)
}

function currentPhase(): FailurePhase {
  return isReactFatalHostMounted() ? 'running' : 'react-mount'
}

function parseViteError(payload: unknown): ParsedViteError {
  if (!isRecord(payload)) {
    return {
      error: createError('ViteError', safeStringify(payload)),
      context: {
        collector: 'vite-diagnostic',
        diagnosticSource: 'vite',
      },
    }
  }

  const payloadError = payload['error']

  const rawError = isRecord(payloadError) ? payloadError : payload

  const locationValue = rawError['location']

  const rawLocation = isRecord(locationValue) ? locationValue : undefined

  const error = createError(
    readString(rawError, 'name') ?? 'ViteError',
    readString(rawError, 'message') ??
      readString(rawError, 'msg') ??
      'Unknown Vite development error',
    readString(rawError, 'stack'),
  )

  const source = readString(rawLocation, 'file') ?? readString(rawError, 'id')

  const line = readNumber(rawLocation, 'line')

  const column = readNumber(rawLocation, 'column')

  return {
    error,
    ...optionalProperty('source', source),
    ...optionalProperty('line', line),
    ...optionalProperty('column', column),
    context: {
      collector: 'vite-diagnostic',
      diagnosticSource: readString(payload, 'source') ?? 'vite',
      plugin: readString(rawError, 'plugin') ?? '',
      moduleId: readString(rawError, 'id') ?? '',
      frame: readString(rawError, 'frame') ?? '',
      pluginCode: readString(rawError, 'pluginCode') ?? '',
    },
  }
}

function createError(name: string, message: string, stack?: string): Error {
  const error = new Error(message)
  error.name = name

  if (stack !== undefined) {
    error.stack = stack
  }

  return error
}

function readString(
  record: Record<string, unknown> | undefined,
  property: string,
): string | undefined {
  const value = record?.[property]

  return typeof value === 'string' ? value : undefined
}

function readNumber(
  record: Record<string, unknown> | undefined,
  property: string,
): number | undefined {
  const value = record?.[property]

  return typeof value === 'number' ? value : undefined
}

function nonEmptyString(value: string): string | undefined {
  return value.length > 0 ? value : undefined
}

function positiveNumber(value: number): number | undefined {
  return value > 0 ? value : undefined
}

function emergencyLogIncident(incident: {
  readonly id: string
  readonly code: string
  readonly technicalMessage: string
}): void {
  try {
    console.error('[Poietica Fatal Incident]', incident)
  } catch {}
}
