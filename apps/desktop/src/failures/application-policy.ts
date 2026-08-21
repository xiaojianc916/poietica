import type { FailureImpact, FailureRecovery, FailureScope } from '@poietica/core'
import { optionalProperty } from '@poietica/core'
import { type FailureIncident, type FailureSignal, failureCoordinator } from './coordinator'

export const APPLICATION_FAILURE_CODES = [
  'WINDOW_MINIMIZE_UNAVAILABLE',
  'WINDOW_MAXIMIZE_UNAVAILABLE',
  'WINDOW_DRAG_UNAVAILABLE',
  'DEVELOPER_TOOLS_UNAVAILABLE',
  'SETTINGS_LOAD_FAILED',
  'WINDOW_STATE_QUERY_UNAVAILABLE',
  'WINDOW_RESIZE_SYNC_UNAVAILABLE',
  'WINDOW_CLOSE_LISTENER_UNAVAILABLE',
  'AGENT_SELECTION_UNAVAILABLE',
  'AGENT_CAPABILITIES_UNREADABLE',
  'AGENT_CONFIG_CHANGE_REJECTED',
  'SESSION_CONFIG_CHANGE_REJECTED',
  'THREAD_REOPEN_FAILED',
  'THREAD_MODES_NOT_KEPT',
  'GIT_BRANCH_OPERATION_FAILED',
  'UPDATE_DOWNLOAD_FAILED',
] as const

export type ApplicationFailureCode = (typeof APPLICATION_FAILURE_CODES)[number]

/**
 * The features this application knows how to lose.
 *
 * A degraded feature is a promise withdrawn: something the interface offered
 * a moment ago and cannot offer now. Listing them here means the set is
 * reviewable in one place, and that a policy cannot disable a feature nobody
 * ever declared — a typo would be a type error rather than a control that
 * silently never comes back.
 */
export const DEGRADABLE_FEATURE_IDS = [
  'developer-tools',
  'settings',
  'window-close-coordination',
  'window-controls',
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
    impact: 'feature-degraded',
    userMessage: '窗口最小化暂时不可用。',

    recovery: 'disable-feature',

    scope: featureScope('window-controls'),
  },

  WINDOW_MAXIMIZE_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口最大化或还原暂时不可用。',

    recovery: 'disable-feature',

    scope: featureScope('window-controls'),
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

  WINDOW_RESIZE_SYNC_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口尺寸状态同步暂时不可用。',

    recovery: 'disable-feature',

    scope: featureScope('window-state-sync'),
  },

  WINDOW_CLOSE_LISTENER_UNAVAILABLE: {
    impact: 'feature-degraded',
    userMessage: '窗口关闭协调暂时不可用。',

    recovery: 'disable-feature',

    scope: featureScope('window-close-coordination'),
  },

  /*
   * 没能读到 agent 现在给得出哪些选项：模型、模式、推理档位，同一次往返里一起来。
   *
   * 此前这一路只写一条日志：选择器空着，屏幕上没有任何解释 —— 而 agent 的 stderr
   * 恰恰说得出是哪一行配置坏了。一次往返失手不是功能没了，重进这一格就会再问一次，
   * 所以 recovery 是 retry。
   */
  /*
   * 这一条还盖着一个它不该盖的情形：全新安装。
   *
   * 上面那段推理对"偶发失败"成立，对"从来没配过"完全不成立 —— 新电脑上
   * agent CLI 没装、密钥没填，重试一万次结果一样，缺的不是运气，是一个还不
   * 存在的前提。三种处境（没装 / 没配 / 真的失手）现在共用同一个错误码和
   * 同一句话，而前两种根本不是错误，是"还没开始"。
   *
   * 分开它们要新增一个首次运行状态，不是改一句文案能做到的事。在那之前，
   * 这句话至少要把人指向唯一能解决问题的地方 —— 设置页会说出真实的原因：
   * 程序找不到、还是密钥没填。让人对着一句"没能读到"按重试，是最坏的一种。
   */
  AGENT_SELECTION_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '无法读取当前 Agent 配置，暂时无法启动 Agent；修正配置后会自动恢复。',
    recovery: 'retry',
    scope: operationScope('load-agent-selection'),
  },

  AGENT_CAPABILITIES_UNREADABLE: {
    impact: 'recoverable',
    userMessage: '没能读到可用的模型。到「设置 → 模型」看看 agent 装好了没有、密钥填了没有。',

    recovery: 'retry',

    scope: operationScope('read-capabilities'),
  },
  /*
   * 这一次改动 agent 没接受。
   *
   * 与上面那条分开，因为它们要人做的事不一样：读不到多半是还没装好、密钥没填，
   * 该去设置页；改不动说明表读得到、只是这一次没生效，去设置页什么也解决不了。
   * 共用一句话的那段时间里，每一次改动失败都在说「密钥可能没填」，而密钥是好的。
   *
   * 不列原因：agent 拒绝的措辞是它自己的，脱敏之后剩不下能对人说的东西 —— 与
   * 下面那条同一条规矩。屏幕已经退回它真在用的值，所以这句话只需要说清「没换成」。
   *
   * 作用域是一次操作而不是一个功能：选择器照常能用，没有任何控件需要变灰。
   */
  AGENT_CONFIG_CHANGE_REJECTED: {
    impact: 'recoverable',
    userMessage: '这次改动没有生效，选择器已经退回 agent 正在用的值。可以再试一次。',

    recovery: 'retry',

    scope: operationScope('change-capability'),
  },
  /*
   * 这一条对话的会话设置没换成。
   *
   * 与上面那条的区别不是严重程度，是作用域。那一条改的是这一家 agent 的默认值
   * （落到 config.toml 的 default_model，此后每一条新对话都跟着变）；这一条改的
   * 是一条对话背后那个会话（ACP 的 session/set_config_option，按 sessionId 寻址，
   * 别的对话一个字节都不动）。同一句话盖两边，人会以为刚才那次失败的改动影响了
   * 所有对话。
   *
   * 不列 agent 拒绝的措辞：那是它自己的话，脱敏之后剩不下能对人说的东西 —— 与下
   * 面那条更新失败同一条规矩。屏幕上那颗胶囊已经退回它真在用的值（见
   * SessionControlsStore.#dispatch 的 catch：向权威重问一次，不在本地猜一个旧值
   * 填回去），所以这句话只需要说清「这条没换成」，以及它还能再试。
   *
   * 作用域是一次操作而不是一个功能：别的对话照常，没有任何控件需要变灰。
   */
  SESSION_CONFIG_CHANGE_REJECTED: {
    impact: 'recoverable',
    userMessage: '这条对话的设置没有改成，选择器已经退回它正在用的值。可以再试一次。',

    recovery: 'retry',

    scope: operationScope('change-session-config'),
  },
  /*
   * 这条对话没能重新连上。
   *
   * 不并进「没能读到可用的模型」那一条：后者说的是这一家 agent 装没装好、密钥填
   * 没填，而这里是一条具体的对话握不住会话，别的对话可能好着。并进去就会把人送
   * 去设置页检查一把本来就是对的钥匙。
   *
   * 屏幕上另有两处已经在说这件事：那一格的 selectorFailure（可以点重试），以及
   * 转录那一侧报这条对话打不开。这一条走的是第三个用途 —— 日志与降级。三处同一
   * 份原因，措辞各按各的用途。
   *
   * 作用域是一次操作：重试就在那一格上，没有功能需要变灰。
   */
  THREAD_REOPEN_FAILED: {
    impact: 'recoverable',
    userMessage: '这条对话没能重新连上 agent。可以在设置那一格点重试。',

    recovery: 'retry',

    scope: operationScope('reopen-thread'),
  },
  /*
   * 模式没能记住：目标与蜂群同存一格，所以说的是模式。
   *
   * 这一轮照常带着模式出发（真相在内存那一份），失手的只是它在下次启动时还在不在，
   * 所以作用域是一次操作、不是一个功能：没有任何控件需要变灰。
   */
  THREAD_MODES_NOT_KEPT: {
    impact: 'recoverable',
    userMessage: '这条对话的模式没能记住，重启后需要重新设置。',
    recovery: 'retry',
    scope: operationScope('keep-thread-modes'),
  },
  /*
   * Git 的拒绝理由通过统一失败管线直接进入全局 toast。菜单不持有错误副本，
   * toast 负责限制视觉体量，诊断文本本身不在这里重写。
   */
  GIT_BRANCH_OPERATION_FAILED: {
    impact: 'recoverable',
    userMessage: 'Git 分支操作失败',
    recovery: 'retry',
    scope: operationScope('git-branch-operation'),
  },
  /*
   * 更新没能下下来。
   *
   * 不是"功能受限"：应用一切照旧，装着的这一版一个字节都没被改动，失手的只是
   * 一次可以随时再来的下载。所以 impact 是 recoverable、recovery 是 retry，
   * 作用域是一次操作而不是一个功能——feature 作用域会把控件变灰，而这里没有
   * 任何控件需要变灰。
   *
   * 具体原因（网络、签名、更新源）不进这句话：它们在原生日志里，而脱敏之后
   * 能说出口的那句是"插件操作失败"，对着用户说等于什么都没说。
   */
  UPDATE_DOWNLOAD_FAILED: {
    impact: 'recoverable',
    userMessage: '更新没能下载完成，当前版本没有被改动。',

    recovery: 'retry',

    scope: operationScope('download-update'),
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

/*
 * 一次操作失手，不是一个功能没了。
 *
 * 可恢复的失败不许挂 application / native-process 作用域（见 kernel 的
 * validateFailurePolicy），而 feature 作用域会把它算进"降级的功能"里、让控件
 * 变灰 —— 那不是这里要的：选择器照常能用。
 */
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
