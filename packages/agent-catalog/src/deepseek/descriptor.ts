import type { AgentDescriptor } from '../agent-descriptor'

/**
 * deepseek-harness 的 SDK 运行时。
 *
 * 起的是官方 bin。它自己不带配置：配置只从 DSH_CORDIS_CONFIG 或 argv[2] 来，
 * 两处都不指向存在的文件时，bin 打一行用法到 stderr 并以 1 退出。所以受控
 * 配置的路径必须设上，没有兜底可依赖。
 *
 * stdout 只走协议帧，受控配置里不得挂 stdout logger，诊断一律走 stderr。
 *
 * 没有 install：这一家怎么问已装版本，官方没有说法，说不出就不写 —— 界面
 * 于是什么都不画，而不是画一个点了会失败的按钮。
 */
export const deepseekHarness: AgentDescriptor = {
  id: 'deepseek-harness',
  displayName: 'DeepSeek',
  transport: 'deepseek-harness',
  command: 'dsh-jsonrpc-agent',
  args: [],
  configVar: 'DSH_CORDIS_CONFIG',
  optionLabels: {},
}
