import { z } from 'zod'

export const TerminalId = z.string().regex(/^t\d+$/)
export const TerminalInfo = z.object({
  terminalId: TerminalId,
  cwd: z.string(),
  shell: z.string(), // 可执行文件的完整路径
  title: z.string(), // 显示名：'pwsh' | 'powershell' | 'cmd'
  exited: z.boolean(),
  exitCode: z.number().int().nullable(),
})
export type TerminalInfo = z.infer<typeof TerminalInfo>
export const MAX_TERMINALS = 10
/** 每个终端保留最近 256 KB 输出用于重放。 */
export const REPLAY_BYTES = 256 * 1024
