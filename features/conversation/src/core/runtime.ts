import type { RuntimeServices } from '@poietica/runtime-protocol'

/**
 * conversation 需要的运行时能力：开会话/读会话文件/草稿控件/命令表 + 模型与设置。
 * 不是完整引擎：工具注册、冻结、浏览器 relay、扩展管理都不在视野里。
 */
export type ConversationRuntime = RuntimeServices['sessions'] & Pick<RuntimeServices, 'models' | 'settings'>
