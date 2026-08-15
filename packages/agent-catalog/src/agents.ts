import type { AgentDescriptor } from './agent-descriptor'
import { deepseekHarness } from './deepseek/descriptor'
import { kimiCode } from './kimi/descriptor'

export type { AgentDescriptor, QuestionDialect } from './agent-descriptor'

/*
 * 软件支持哪几家 ACP agent。
 *
 * 名单是封闭的：用户在这几家里选，不能自带一条命令。所以这里没有解析、没有
 * 校验、没有反注入 —— 那些是给「用户可以填任意命令」准备的，而这个入口不存在。
 *
 * 接第 N 家 = 新增一个 <id>/descriptor.ts，然后在这张表里加一行。通用层一个字
 * 都不用改；如果改了，就说明还没解耦干净。
 *
 * 类型是非空元组，不是数组：「一家都没有」在编译期就不成立。
 *
 * 地址就是 string，唯一判据是查表；「默认哪一家」是用户在这台机器上的选择，
 * 产地是档案集的 defaultProfileId（见 acp-agent-profile.ts），不是名单的顺序。
 */
const AGENTS = [kimiCode, deepseekHarness] as const satisfies readonly [
  AgentDescriptor,
  ...AgentDescriptor[],
]

export function agentRoster(): readonly [AgentDescriptor, ...AgentDescriptor[]] {
  return AGENTS
}

/** 按 id 取档案。名单封闭，取不到不是常态，所以由调用方决定怎么处置。 */
export function agentById(id: string): AgentDescriptor | undefined {
  return AGENTS.find((agent) => agent.id === id)
}
