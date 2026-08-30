import { commands, type UsageDay } from '@poietica/contract'
import { throughIpc } from './error'

/*
 * Token 日账：只有读。
 *
 * 写在原生侧发生（agent 报一次就记一次），这一层没有对应的写命令，也不该有。
 */

export type { UsageDay }

/** 最近 span 天的日账，由早到晚。没有账的日子不占行。 */
export function readTokenDays(span: number): Promise<UsageDay[]> {
  return throughIpc(() => commands.usageTokenDays(span))
}
