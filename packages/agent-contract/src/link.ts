/**
 * 这条连接的重连进度。
 *
 * 链路态，不是回合的一部分：它不占帧的序号、不进帧日志，所以重放一条对话时不会
 * 再出现一次。attempt 为 null 即已接上。
 */
export interface SessionLink {
  readonly attempt: number | null
  readonly of: number
}

/** 重连进度的到达口。只有订阅：没有哪个命令能把它问回来。 */
export interface SessionLinkPort {
  readonly subscribe: (handler: (link: SessionLink) => void) => () => void
}
