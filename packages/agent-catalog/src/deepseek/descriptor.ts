import type { AgentDescriptor } from '../agent-descriptor'

/**
 * deepseek-harness 的 SDK 线运行时。
 *
 * 官方 @deepseek-ai/dsh-sdk-jsonrpc-server 的 README：stdout 只走 JSON-RPC 帧，
 * 诊断走 stderr；持久化与人格来自外层 cordis.yml —— 那份配置的路径由用户档案的
 * env 表交进来，这一层不猜。
 *
 * 没有 install：这一家怎么问已装版本官方没有说法，说不出就不写。
 */
export const deepseekHarness = {
  id: 'deepseek-harness',
  displayName: 'DeepSeek',
  transport: 'deepseek-harness',
  command: 'dsh-jsonrpc-agent',
  args: [],
  optionLabels: {},
} as const satisfies AgentDescriptor
