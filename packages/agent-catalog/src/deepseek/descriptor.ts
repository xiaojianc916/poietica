import type { AgentDescriptor } from '../agent-descriptor'

/**
 * deepseek-harness 的 SDK 线运行时。
 *
 * 官方 @deepseek-ai/dsh-sdk-jsonrpc-server 的 README：stdout 只走 JSON-RPC 帧，
 * 诊断走 stderr。
 *
 * 没有 command 也没有 args：这条线的 argv 不是一个名字。官方 python/sdk-runtime
 * 的 resolve_bundled_launch_args 交回一个元组 —— exe 模式 (exe_path,)，node 模式
 * (node_path, bin_js_path) —— 并写明获取渠道与查询接口是分开的，好让按需下载以后
 * 能替换掉前者而不动调用方。所以启动规格由原生侧问那个已安装的包。
 *
 * 没有 install：官方的获取渠道是 PyPI 平台 wheel（deepseek-harness-runtime-bin），
 * 而 AgentInstall 说的是 npm 包名，装不下它。
 */
export const deepseekHarness = {
  id: 'deepseek-harness',
  displayName: 'DeepSeek',
  transport: 'deepseek-harness',
  optionLabels: {},
} as const satisfies AgentDescriptor
