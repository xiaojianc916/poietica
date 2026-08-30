import type { EnvironmentFile } from '@poietica/contract'
import { commands } from '@poietica/contract'
import { throughIpc } from './error'

export type { EnvironmentFile } from '@poietica/contract'

/*
 * 这个 agent 自己那份 mcp.json。路径由原生侧算，这一层不拼也不猜：受控 home 生效时
 * 在本应用数据根之下，不受控时在用户自己的家里，判断的唯一产地是 profile.rs。
 */
export function readEnvironmentMcpConfig(): Promise<EnvironmentFile> {
  return throughIpc(() => commands.environmentMcpConfig())
}

/*
 * 改写受控 home 里那份 mcp.json。expectedContents 是这次读—改—写开始时读到的原文
 * （文件不存在时是 null），原生侧比不上就拒绝，两个并发写者谁也抹不掉谁；不受控时
 * 一律拒绝 —— 那份文件是用户终端里的那套服务器，不归本应用写。
 */
export function writeEnvironmentMcpConfig(
  expectedContents: string | null,
  contents: string,
): Promise<EnvironmentFile> {
  return throughIpc(() => commands.environmentMcpConfigWrite(expectedContents, contents))
}
