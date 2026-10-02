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

/*
 * 会话可以开了没有；原生侧起连接之前必须走完这一步（mcp.json 是 agent 启动时读一次的
 * 文件，得排在 spawn 之前）。已经不carry「起哪一家」：只有一家 agent，身份由原生侧从
 * 接入档案里读。
 */
export type AgentReady = () => Promise<void>

export interface AgentBridgeOptions {
  readonly ready: AgentReady
  readonly cwd?: () => string | null
}
