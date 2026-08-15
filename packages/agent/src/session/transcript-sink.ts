import type { ThreadAttachment, ThreadHistory } from '@poietica/agent-contract'

/**
 * 转录那一侧，会话这一侧要用到的全部。
 *
 * 注入而不是 import 一个单例：实例由组合根造出来，测试因此塞得进一个假的，而
 * 「一个 store 订着一条线路」那道守卫也才是实例级而不是进程级的。窄到只剩这
 * 几句，是为了让那个假的写得出来。
 */
export interface TranscriptSink {
  readonly opening: (threadId: string) => void
  readonly adopt: (
    threadId: string,
    events: readonly unknown[],
    history: ThreadHistory,
    attachments: readonly ThreadAttachment[],
    prompts: number,
  ) => void
  readonly failed: (threadId: string, cause: unknown) => void
  /** 运行帧按会话号到达，而这一侧的一切按对话记：这是两者之间唯一的那张表。 */
  readonly route: (sessionId: string, threadId: string) => void
  /** 这条对话不存在了：转录连同指向它的路由一起作废。 */
  readonly forget: (threadId: string) => void
}
