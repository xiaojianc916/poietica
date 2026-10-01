import type { AgentLaunch } from '@poietica/contract'

/*
 * 挑一个保存落点；取消即 null。
 *
 * 做成注入而不是让会话端口直接 import 宿主端口：那一层只走共享的 IPC 边界，
 * 不碰无关的宿主集成（判据 tools/architecture/native-conversation-boundaries.ts）。
 */
export type PickSavePath = (options: {
  readonly defaultPath: string
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[]
}) => Promise<string | null>

export interface AgentBridgeOptions {
  readonly launch: () => AgentLaunch | Promise<AgentLaunch>
  readonly cwd?: () => string | null
}
