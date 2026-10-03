import { commands, type UsageDay, type UsageModelDay } from '@poietica/contract'
import { throughIpc } from './ipc-error'

/*
 * 用量账：只有读。
 *
 * 写在原生侧发生（agent 报一次就记一次），这一层没有对应的写命令，也不该有。
 * 三格同出一本账：日账给热力图，按模型的日账给趋势图，句子数给概览那一格。
 */

export type { UsageDay, UsageModelDay }

/** 最近 span 天的日账，由早到晚。没有账的日子不占行。 */
export function readTokenDays(span: number): Promise<UsageDay[]> {
  return throughIpc(() => commands.usageTokenDays(span))
}

/** 最近 span 天里每个模型各自的日账，由早到晚。 */
export function readModelDays(span: number): Promise<UsageModelDay[]> {
  return throughIpc(() => commands.usageModelDays(span))
}

/** 最近 span 天里发出去的句子数。 */
export function readMessageCount(span: number): Promise<number> {
  return throughIpc(() => commands.usageMessageCount(span))
}
