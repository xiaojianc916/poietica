import type {
  FailureImpact,
  FailureIncident,
  FailureRecovery,
  FailureScope,
  FailureSignal,
  TerminalFailureImpact,
  TerminalFailureIncident,
} from '@poietica/problem'
import { failureCoordinator, formatFailureDiagnostic, optionalProperty } from '@poietica/problem'

export const APPLICATION_FAILURE_CODES = [
  'WINDOW_MINIMIZE_UNAVAILABLE',
  'WINDOW_MAXIMIZE_UNAVAILABLE',
  'WINDOW_CLOSE_UNAVAILABLE',
  'WINDOW_DRAG_UNAVAILABLE',
  'DEVELOPER_TOOLS_UNAVAILABLE',
  'SETTINGS_LOAD_FAILED',
  'WINDOW_STATE_QUERY_UNAVAILABLE',
  'WINDOW_STATE_SYNC_UNAVAILABLE',
  'WINDOW_SURFACE_SYNC_UNAVAILABLE',
  'WINDOW_CLOSE_LISTENER_UNAVAILABLE',
  'AGENT_CAPABILITIES_UNREADABLE',
  'AGENT_CONFIG_CHANGE_REJECTED',
  'SESSION_CONFIG_CHANGE_REJECTED',
  'THREAD_REOPEN_FAILED',
  'THREAD_MODES_NOT_KEPT',
  'WORKSPACE_PICK_FAILED',
  'GIT_BRANCH_OPERATION_FAILED',
  'GIT_CHANGES_UNREADABLE',
  'GIT_REVIEW_ACTION_FAILED',
  'UPDATE_CHECK_FAILED',
  'UPDATE_DOWNLOAD_FAILED',
  'UPDATE_INSTALL_FAILED',
  'UNHANDLED_WINDOW_ERROR',
  'UNHANDLED_PROMISE_REJECTION',
] as const

export type ApplicationFailureCode = (typeof APPLICATION_FAILURE_CODES)[number]

export const DEGRADABLE_FEATURE_IDS = [
  'developer-tools',
  'settings',
  'window-close-coordination',
  'window-dragging',
  'window-state-sync',
] as const

export type DegradableFeatureId = (typeof DEGRADABLE_FEATURE_IDS)[number]

export type FailureReportContext = Readonly<Record<string, unknown>>

interface ApplicationFailurePolicy {
  readonly impact: FailureImpact

  readonly userMessage: string

  readonly recovery: FailureRecovery

  readonly scope: (context: FailureReportContext) => FailureScope
}

export const APPLICATION_FAILURE_POLICIES = {
  WINDOW_MINIMIZE_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '窗口最小化失败，可以重试。',
    recovery: 'retry',
    scope: operationScope('minimize-window'),
  },

  WINDOW_MAXIMIZE_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '窗口最大化或还原失败，可以重试。',
    recovery: 'retry',
    scope: operationScope('toggle-maximize-window'),
  },

  WINDOW_CLOSE_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '应用未能退出，请重试或使用托盘中的强制退出。',
    recovery: 'retry',
    scope: operationScope('quit-application'),
  },

  WINDOW_DRAG_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口拖动暂时不可用。',

    recovery: 'disable-feature',

    scope: featureScope('window-dragging'),
  },

  DEVELOPER_TOOLS_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '开发者工具暂时不可用。',

    recovery: 'disable-feature',

    scope: featureScope('developer-tools'),
  },

  SETTINGS_LOAD_FAILED: {
    impact: 'feature-degraded',
    userMessage: '设置读取失败，当前会话将使用默认设置。',

    recovery: 'disable-feature',

    scope: featureScope('settings'),
  },

  WINDOW_STATE_QUERY_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '无法同步窗口状态。',

    recovery: 'disable-feature',

    scope: featureScope('window-state-sync'),
  },

  WINDOW_STATE_SYNC_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口状态同步暂时不可用。',

    recovery: 'disable-feature',

    scope: featureScope('window-state-sync'),
  },

  WINDOW_SURFACE_SYNC_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '窗口底色未能与当前主题同步，界面仍可继续使用。',
    recovery: 'dismiss',
    scope: operationScope('sync-window-surface'),
  },

  WINDOW_CLOSE_LISTENER_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口关闭协调暂时不可用。',

    recovery: 'disable-feature',

    scope: featureScope('window-close-coordination'),
  },

  AGENT_CAPABILITIES_UNREADABLE: {
    impact: 'recoverable',
    userMessage: '没能读到可用的模型。到「设置 → 模型」看看 agent 装好了没有、密钥填了没有。',

    recovery: 'retry',

    scope: operationScope('read-capabilities'),
  },

  AGENT_CONFIG_CHANGE_REJECTED: {
    impact: 'recoverable',
    userMessage: '这次改动没有生效，选择器已经退回 agent 正在用的值。可以再试一次。',

    recovery: 'retry',

    scope: operationScope('change-capability'),
  },

  SESSION_CONFIG_CHANGE_REJECTED: {
    impact: 'recoverable',
    userMessage: '这条对话的设置没有改成，选择器已经退回它正在用的值。可以再试一次。',

    recovery: 'retry',

    scope: operationScope('change-session-config'),
  },

  THREAD_REOPEN_FAILED: {
    impact: 'recoverable',
    userMessage: '这条对话没能重新连上 agent。可以在设置那一格点重试。',

    recovery: 'retry',

    scope: operationScope('reopen-thread'),
  },

  THREAD_MODES_NOT_KEPT: {
    impact: 'recoverable',
    userMessage: '这条对话的模式没能记住，重启后需要重新设置。',
    recovery: 'retry',
    scope: operationScope('keep-thread-modes'),
  },

  WORKSPACE_PICK_FAILED: {
    impact: 'recoverable',
    userMessage: '工作目录选择器未能打开，可以重试。',
    recovery: 'retry',
    scope: operationScope('pick-workspace'),
  },
  GIT_BRANCH_OPERATION_FAILED: {
    impact: 'recoverable',
    userMessage: 'Git 分支操作失败',
    recovery: 'retry',
    scope: operationScope('git-branch-operation'),
  },
  /* 读不到变更清单：审查那一格自己说读取失败，控件不变灰，重进就再问一次。 */
  GIT_CHANGES_UNREADABLE: {
    impact: 'recoverable',
    userMessage: 'Git 变更读取失败',
    recovery: 'retry',
    scope: operationScope('git-changes'),
  },
  /* 提交或推送被 git 拒绝：理由原文走统一失败管线进 toast，面板不留错误副本。 */
  GIT_REVIEW_ACTION_FAILED: {
    impact: 'recoverable',
    userMessage: 'Git 提交或推送失败',
    recovery: 'retry',
    scope: operationScope('git-review-action'),
  },

  /* 只出自人亲手要的那次检查：后台按节奏问的那条自己咽下去，离线是常态。 */
  UPDATE_CHECK_FAILED: {
    impact: 'recoverable',
    userMessage: '没能连上更新服务，暂时问不到有没有新版本。',
    recovery: 'dismiss',
    scope: operationScope('check-update'),
  },
  UPDATE_DOWNLOAD_FAILED: {
    impact: 'recoverable',
    userMessage: '更新没能下载完成，当前版本没有被改动。',
    recovery: 'retry',
    scope: operationScope('download-update'),
  },
  /* 那份字节已经被消耗，store 会退回 idle 让下一轮检查重新发现。 */
  UPDATE_INSTALL_FAILED: {
    impact: 'recoverable',
    userMessage: '更新没能装上，当前版本没有被改动。',
    recovery: 'retry',
    scope: operationScope('install-update'),
  },

  UNHANDLED_WINDOW_ERROR: {
    impact: 'recoverable',
    userMessage: '有一处操作出错了，界面仍在正常运行。',
    recovery: 'dismiss',
    scope: operationScope('window-error'),
  },

  UNHANDLED_PROMISE_REJECTION: {
    impact: 'recoverable',
    userMessage: '有一处后台任务出错了，界面仍在正常运行。',
    recovery: 'dismiss',
    scope: operationScope('unhandled-rejection'),
  },
} as const satisfies Readonly<Record<ApplicationFailureCode, ApplicationFailurePolicy>>

export function reportFailure(
  code: ApplicationFailureCode,

  context: FailureReportContext,
): FailureIncident {
  const policy = APPLICATION_FAILURE_POLICIES[code]

  const cause = context['cause']

  const componentStack = readOptionalString(context, 'componentStack')

  const source = readOptionalString(context, 'source')

  const line = readOptionalNumber(context, 'line')

  const column = readOptionalNumber(context, 'column')

  const signal: FailureSignal = {
    impact: policy.impact,
    code,
    userMessage: policy.userMessage,

    scope: policy.scope(context),

    recovery: policy.recovery,

    ...optionalProperty('cause', cause),

    context: removeCause(context),

    diagnostic: {
      ...optionalProperty('componentStack', componentStack),

      ...optionalProperty('source', source),

      ...optionalProperty('line', line),

      ...optionalProperty('column', column),
    },
  }

  return failureCoordinator.report(signal)
}

function featureScope(
  featureId: DegradableFeatureId,
): (context: FailureReportContext) => FailureScope {
  return (_context) => ({
    kind: 'feature',
    featureId,
  })
}

function operationScope(operation: string): (context: FailureReportContext) => FailureScope {
  return (_context) => ({
    kind: 'operation',
    operation,
  })
}

function removeCause(context: FailureReportContext): Readonly<Record<string, unknown>> {
  const entries = Object.entries(context).filter(([key]) => key !== 'cause')

  return Object.fromEntries(entries)
}

function readOptionalString(
  context: FailureReportContext,

  key: string,
): string | undefined {
  const value = context[key]

  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readOptionalNumber(
  context: FailureReportContext,

  key: string,
): number | undefined {
  const value = context[key]

  return typeof value === 'number' ? value : undefined
}

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
