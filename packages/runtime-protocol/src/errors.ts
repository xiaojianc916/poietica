// 引擎层错误码（AppError.code 取值）。engine 位于 L1，不依赖 contract-kit，所以用常量定义；
// conversation 等契约在自己的 errors 中 re-export 这些码，供 UI 显示。
export const EngineErrorCode = {
  providerNotConfigured: 'engine.provider_not_configured',
  modelNotFound: 'engine.model_not_found',
  busy: 'engine.busy',
  interactionExpired: 'engine.interaction_expired',
  sessionFileMissing: 'engine.session_file_missing',
  toolsFrozen: 'engine.tools_frozen',
  upstream: 'engine.upstream_error', // 模型服务商返回的错误；message 为服务商原文
  planUnavailable: 'engine.plan_unavailable',
  goalUnavailable: 'engine.goal_unavailable',
  queueItemConsumed: 'engine.queue_item_consumed', // 这条排队项已经被 agent 取走，撤不回来了
  commandUnknown: 'engine.command_unknown', // 不是 omp 认识的斜杠命令（或是 GUI 宿主办不了的那几条）
  subagentNotRunning: 'engine.subagent_not_running', // 子代理已经结束（或已被父轮收下结果），不能再引导
  sideBusy: 'engine.side_busy', // 侧边提问同一时刻只答一问：上一问还没答完
  sideTopicUnknown: 'engine.side_topic_unknown', // 追问的侧边话题不在这条会话里（可能是重开前的旧号）
  sideUnavailable: 'engine.side_unavailable', // 会话没有可用模型，侧边提问无从答起
  sideFailed: 'engine.side_failed', // 侧边提问没能开问（例如话题存不了盘）；message 为原因
} as const
export type EngineErrorCode = (typeof EngineErrorCode)[keyof typeof EngineErrorCode]

/** UI 错误标题的默认文案；apps/desktop 的 main.tsx 把它与 appContract.errorMessages 合并。 */
export const engineErrorMessages: Readonly<Record<EngineErrorCode, string>> = Object.freeze({
  'engine.provider_not_configured': '尚未配置该模型服务商的 API key',
  'engine.model_not_found': '找不到所选模型',
  'engine.busy': 'agent 正忙',
  'engine.interaction_expired': '该请求已失效',
  'engine.session_file_missing': '会话文件已丢失',
  'engine.tools_frozen': '工具注册已关闭',
  'engine.upstream_error': '模型服务返回错误',
  'engine.plan_unavailable': '计划模式已在 Agent 设置里关闭',
  'engine.goal_unavailable': '目标模式已在 Agent 设置里关闭',
  'engine.queue_item_consumed': '这条消息已经交给 agent，撤不回来了',
  'engine.command_unknown': '没有这条命令',
  'engine.subagent_not_running': '这个子代理已经结束了',
  'engine.side_busy': '上一个侧边提问还没答完',
  'engine.side_topic_unknown': '找不到这个侧边话题',
  'engine.side_unavailable': '这条对话还没有可用的模型',
  'engine.side_failed': '侧边提问没能开始',
})
