import type {
  FailureImpact,
  FailureIncident,
  FailureRecovery,
  FailureScope,
  FailureSignal,
} from '@poietica/problem'
import { failureCoordinator, optionalProperty } from '@poietica/problem'

/* 可恢复 / 功能降级失败的上报。终态崩溃的上报与崩溃屏视图在 fatal-incident.ts。 */

export const APPLICATION_FAILURE_CODES = [
  'WINDOW_MINIMIZE_UNAVAILABLE',
  'WINDOW_MAXIMIZE_UNAVAILABLE',
  'WINDOW_CLOSE_UNAVAILABLE',
  'WINDOW_DRAG_UNAVAILABLE',
  'DEVELOPER_TOOLS_UNAVAILABLE',
  'SETTINGS_LOAD_FAILED',
  'SETTINGS_APPLICATION_FAILED',
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

  readonly scope: FailureScope
}

export const APPLICATION_FAILURE_POLICIES = {
  WINDOW_MINIMIZE_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '窗口最小化失败，可以重试。',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'minimize-window' },
  },

  WINDOW_MAXIMIZE_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '窗口最大化或还原失败，可以重试。',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'toggle-maximize-window' },
  },

  WINDOW_CLOSE_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '应用未能退出，请重试或使用托盘中的强制退出。',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'quit-application' },
  },

  WINDOW_DRAG_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口拖动暂时不可用。',

    recovery: 'disable-feature',

    scope: { kind: 'feature', featureId: 'window-dragging' },
  },

  DEVELOPER_TOOLS_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '开发者工具暂时不可用。',

    recovery: 'disable-feature',

    scope: { kind: 'feature', featureId: 'developer-tools' },
  },

  SETTINGS_APPLICATION_FAILED: {
    impact: 'recoverable',
    userMessage: '设置已保存，但守护进程未能应用。重新切换守护进程设置或重启应用可再次应用。',
    recovery: 'dismiss',
    scope: { kind: 'operation', operation: 'apply-settings' },
  },
  SETTINGS_LOAD_FAILED: {
    impact: 'feature-degraded',
    userMessage: '设置读取失败，当前会话将使用默认设置。',

    recovery: 'disable-feature',

    scope: { kind: 'feature', featureId: 'settings' },
  },

  WINDOW_STATE_QUERY_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '无法同步窗口状态。',

    recovery: 'disable-feature',

    scope: { kind: 'feature', featureId: 'window-state-sync' },
  },

  WINDOW_STATE_SYNC_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口状态同步暂时不可用。',

    recovery: 'disable-feature',

    scope: { kind: 'feature', featureId: 'window-state-sync' },
  },

  WINDOW_SURFACE_SYNC_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '窗口底色未能与当前主题同步，界面仍可继续使用。',
    recovery: 'dismiss',
    scope: { kind: 'operation', operation: 'sync-window-surface' },
  },

  WINDOW_CLOSE_LISTENER_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口关闭协调暂时不可用。',

    recovery: 'disable-feature',

    scope: { kind: 'feature', featureId: 'window-close-coordination' },
  },

  AGENT_CAPABILITIES_UNREADABLE: {
    impact: 'recoverable',
    userMessage: 'kimi code模型连接失败',

    recovery: 'retry',

    scope: { kind: 'operation', operation: 'read-capabilities' },
  },

  AGENT_CONFIG_CHANGE_REJECTED: {
    impact: 'recoverable',
    userMessage: '这次改动没有生效，选择器已经退回 agent 正在用的值。可以再试一次。',

    recovery: 'retry',

    scope: { kind: 'operation', operation: 'change-capability' },
  },

  SESSION_CONFIG_CHANGE_REJECTED: {
    impact: 'recoverable',
    userMessage: '这条对话的设置没有改成，选择器已经退回它正在用的值。可以再试一次。',

    recovery: 'retry',

    scope: { kind: 'operation', operation: 'change-session-config' },
  },

  THREAD_REOPEN_FAILED: {
    impact: 'recoverable',
    userMessage: '这条对话没能重新连上 agent。可以在设置那一格点重试。',

    recovery: 'retry',

    scope: { kind: 'operation', operation: 'reopen-thread' },
  },

  THREAD_MODES_NOT_KEPT: {
    impact: 'recoverable',
    userMessage: '这条对话的模式没能记住，重启后需要重新设置。',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'keep-thread-modes' },
  },

  WORKSPACE_PICK_FAILED: {
    impact: 'recoverable',
    userMessage: '工作目录选择器未能打开，可以重试。',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'pick-workspace' },
  },
  GIT_BRANCH_OPERATION_FAILED: {
    impact: 'recoverable',
    userMessage: 'Git 分支操作失败',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'git-branch-operation' },
  },
  /* 读不到变更清单：审查那一格自己说读取失败，控件不变灰，重进就再问一次。 */
  GIT_CHANGES_UNREADABLE: {
    impact: 'recoverable',
    userMessage: 'Git 变更读取失败',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'git-changes' },
  },
  /* 提交或推送被 git 拒绝：理由原文走统一失败管线进 toast，面板不留错误副本。 */
  GIT_REVIEW_ACTION_FAILED: {
    impact: 'recoverable',
    userMessage: 'Git 提交或推送失败',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'git-review-action' },
  },

  /* 只出自人亲手要的那次检查：后台按节奏问的那条自己咽下去，离线是常态。 */
  UPDATE_CHECK_FAILED: {
    impact: 'recoverable',
    userMessage: '没能连上更新服务，暂时问不到有没有新版本。',
    recovery: 'dismiss',
    scope: { kind: 'operation', operation: 'check-update' },
  },
  UPDATE_DOWNLOAD_FAILED: {
    impact: 'recoverable',
    userMessage: '更新没能下载完成，当前版本没有被改动。',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'download-update' },
  },
  /* 那份字节已经被消耗，store 会退回 idle 让下一轮检查重新发现。 */
  UPDATE_INSTALL_FAILED: {
    impact: 'recoverable',
    userMessage: '更新没能装上，当前版本没有被改动。',
    recovery: 'retry',
    scope: { kind: 'operation', operation: 'install-update' },
  },

  UNHANDLED_WINDOW_ERROR: {
    impact: 'recoverable',
    userMessage: '有一处操作出错了，界面仍在正常运行。',
    recovery: 'dismiss',
    scope: { kind: 'operation', operation: 'window-error' },
  },

  UNHANDLED_PROMISE_REJECTION: {
    impact: 'recoverable',
    userMessage: '有一处后台任务出错了，界面仍在正常运行。',
    recovery: 'dismiss',
    scope: { kind: 'operation', operation: 'unhandled-rejection' },
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

    scope: policy.scope,

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
