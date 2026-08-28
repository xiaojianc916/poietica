import type { McpLauncher } from '@poietica/contract'
import { commands } from '@poietica/contract'
import { throughIpc } from './error'

export type { McpLauncher }

/*
 * stdio 条目的启动式，写盘那一刻由原生侧解析并固化（见 commands/launcher.rs）。
 * null = 这台机器上没有这个程序：条目不该被写进去，界面要把这句话说出来。
 */
export function resolveLauncher(program: string): Promise<McpLauncher | null> {
  return throughIpc(async () => commands.launcherResolve(program))
}
