import type {
  FailureIncident,
  FailureRecovery,
  TerminalFailureImpact,
  TerminalFailureIncident,
} from '@poietica/problem'
import { failureCoordinator, formatFailureDiagnostic, optionalProperty } from '@poietica/problem'

/* 这一半是终态读者：进程已不能安全继续时的上报与崩溃屏的视图模型。
   可恢复失败的上报在 problem-presentation.ts。 */

export type FailureKind =
  | 'bootstrap'
  | 'render'
  | 'async'
  | 'invariant'
  | 'vite'
  | 'webview'
  | 'native-crash'

export type FailurePhase =
  | 'preflight'
  | 'runtime-construction'
  | 'react-mount'
  | 'running'
  | 'shutdown'

export interface TerminalFailureInput {
  readonly error: unknown
  readonly impact: TerminalFailureImpact

  readonly kind: FailureKind
  readonly phase: FailurePhase
  readonly code?: string
  readonly title?: string

  readonly componentStack?: string | null

  readonly source?: string
  readonly line?: number
  readonly column?: number

  readonly recovery?: Extract<FailureRecovery, 'reload' | 'restart' | 'exit' | 'none'>

  readonly context?: Readonly<Record<string, unknown>>
}

export function reportFatalIncident(input: TerminalFailureInput): FailureIncident {
  const code = input.code ?? createDefaultCode(input.kind, input.phase)

  return failureCoordinator.report({
    impact: input.impact,

    code,
    userMessage:
      input.impact === 'native-fatal'
        ? 'Poietica 上次运行时异常终止。请复制诊断信息后继续启动。'
        : 'Poietica 无法安全地继续当前运行。请复制诊断信息后重新加载应用。',

    cause: input.error,

    scope:
      input.impact === 'native-fatal'
        ? {
            kind: 'native-process',
          }
        : {
            kind: 'application',
          },

    recovery: input.recovery ?? 'reload',

    context: {
      ...(input.context ?? {}),
      failureKind: input.kind,
      failurePhase: input.phase,
      ...optionalProperty('presentationTitle', input.title),
    },

    diagnostic: {
      ...optionalProperty('componentStack', input.componentStack ?? undefined),

      ...optionalProperty('source', input.source),

      ...optionalProperty('line', input.line),

      ...optionalProperty('column', input.column),
    },
  })
}

let reactFatalHostMounted = false

export function markReactFatalHostMounted(): void {
  reactFatalHostMounted = true
}

export function isReactFatalHostMounted(): boolean {
  return reactFatalHostMounted
}

function createDefaultCode(kind: FailureKind, phase: FailurePhase): string {
  return (
    'FATAL_' +
    kind.replaceAll('-', '_').toUpperCase() +
    '_' +
    phase.replaceAll('-', '_').toUpperCase()
  )
}

/* 复制反馈回到初态的时长。两个渲染器同读这一个数。 */
const COPY_RESET_DELAY_MS = 2200

interface TerminalFailurePrimaryAction {
  readonly kind: 'reload'
  readonly label: string
}

export interface TerminalFailureViewModel {
  readonly title: string
  readonly description: string
  readonly summary: string

  readonly additionalIncidentMessage?: string

  readonly primaryAction: TerminalFailurePrimaryAction | null

  readonly copyActionLabel: string
  readonly copySuccessLabel: string
  readonly copyFailureLabel: string
  readonly copyResetDelayMs: number
  readonly detailsLabel: string
  readonly diagnostic: string
}

export function createTerminalFailureViewModel(
  incident: TerminalFailureIncident,

  additionalIncidentCount = 0,
): TerminalFailureViewModel {
  return Object.freeze({
    title: resolvePresentationTitle(incident),

    description: incident.userMessage,

    summary: createFailureSummary(incident),

    ...optionalProperty(
      'additionalIncidentMessage',
      createAdditionalIncidentMessage(additionalIncidentCount),
    ),

    primaryAction: createPrimaryAction(incident),

    copyActionLabel: '复制诊断信息',

    copySuccessLabel: '已复制',

    copyFailureLabel: '复制失败，请手动选择',

    copyResetDelayMs: COPY_RESET_DELAY_MS,

    detailsLabel: '查看诊断信息',

    diagnostic: formatFailureDiagnostic(incident),
  })
}

const MAX_FAILURE_SUMMARY_LENGTH = 160

function createFailureSummary(incident: TerminalFailureIncident): string {
  const technicalMessage = incident.technicalMessage.replace(/\s+/g, ' ').trim()

  return truncateFailureSummary(technicalMessage || incident.code)
}

function truncateFailureSummary(message: string): string {
  if (message.length <= MAX_FAILURE_SUMMARY_LENGTH) {
    return message
  }

  return `${message.slice(0, MAX_FAILURE_SUMMARY_LENGTH - 1).trimEnd()}…`
}

function resolvePresentationTitle(incident: TerminalFailureIncident): string {
  const configuredTitle = incident.context['presentationTitle']

  if (typeof configuredTitle === 'string' && configuredTitle.trim().length > 0) {
    return configuredTitle
  }

  return incident.impact === 'native-fatal' ? '应用上次异常终止' : '应用遇到严重错误'
}

function createPrimaryAction(
  incident: TerminalFailureIncident,
): TerminalFailurePrimaryAction | null {
  switch (incident.recovery) {
    case 'reload':
      return Object.freeze({
        kind: 'reload',
        label: '重新加载',
      })

    case 'restart':
    case 'exit':
    case 'none':
      return null

    case 'retry':
    case 'dismiss':
    case 'disable-feature':
      return null
  }
}

function createAdditionalIncidentMessage(count: number): string | undefined {
  if (!Number.isInteger(count) || count <= 0) {
    return undefined
  }

  return `此后还捕获到 ${String(count)} 个相关异常。`
}
