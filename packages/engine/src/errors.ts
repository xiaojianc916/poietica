// errors.ts —— 引擎层错误码（AppError.code 取值）。engine 位于 L1，不依赖 contract-kit，所以用常量定义；
// conversation 等契约在自己的 errors 中 re-export 这些码，供 UI 显示。
export const EngineErrorCode = {
  providerNotConfigured: 'engine.provider_not_configured',
  modelNotFound: 'engine.model_not_found',
  busy: 'engine.busy',
  interactionExpired: 'engine.interaction_expired',
  sessionFileMissing: 'engine.session_file_missing',
  toolsFrozen: 'engine.tools_frozen',
  upstream: 'engine.upstream_error', // 模型服务商返回的错误；message 为服务商原文
  planUnavailable: 'engine.plan_unavailable', // 计划模式在 agent 设置里被关掉了
  goalUnavailable: 'engine.goal_unavailable', // 目标模式在 agent 设置里被关掉了
  queueItemConsumed: 'engine.queue_item_consumed', // 这条排队项已经被 agent 取走，撤不回来了
} as const
export type EngineErrorCode = (typeof EngineErrorCode)[keyof typeof EngineErrorCode]

/** UI 错误标题的默认文案。apps/desktop 的 main.tsx 把它与 appContract.errorMessages 合并（06 页 §7）。 */
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
})
