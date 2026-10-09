import type { UiFeatureContext } from '@poietica/ui-kernel'
import { type TerminalInfo, terminalContract } from '../contract'

/**
 * `ctx.rpc(terminalContract)` 的薄封装（与 usage / review 的 ui/api.ts 同形）。
 *
 * 契约说的是「终端」这件事本身：open / write / resize / close / list / replay
 * 加两条通知。大小写与返回值在这里折成人读的形状，界面不认识 RPC 信封。
 */
export function createTerminalApi(ctx: UiFeatureContext) {
  const rpc = ctx.rpc(terminalContract)

  return {
    open: (o: { cwd: string | null; cols: number; rows: number }): Promise<TerminalInfo> =>
      rpc.call('terminal.open', o),
    write: (terminalId: string, data: string): Promise<void> =>
      rpc.call('terminal.write', { terminalId, data }).then(() => undefined),
    resize: (terminalId: string, cols: number, rows: number): Promise<void> =>
      rpc.call('terminal.resize', { terminalId, cols, rows }).then(() => undefined),
    close: (terminalId: string): Promise<void> => rpc.call('terminal.close', { terminalId }).then(() => undefined),
    list: (): Promise<readonly TerminalInfo[]> => rpc.call('terminal.list', {}).then((r) => r.terminals),
    replay: (terminalId: string): Promise<string> => rpc.call('terminal.replay', { terminalId }).then((r) => r.data),
    onOutput: (listener: (p: { terminalId: string; data: string }) => void) => rpc.on('terminal.output', listener),
    onExited: (listener: (p: { terminalId: string; exitCode: number | null }) => void) =>
      rpc.on('terminal.exited', listener),
  }
}

export type TerminalApi = ReturnType<typeof createTerminalApi>
