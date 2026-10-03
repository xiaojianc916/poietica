import type { ConversationRuntime } from '@poietica/conversation'
import type { MainWindowController } from '@poietica/native-bridge/window'

/*
 * 长任务跑完时叫一声。

 * 「谁在跑」的唯一来源是 TranscriptStore 的 running 集合（每条转录的 timeline.status），
 * 所以这里只做一件它不做的事：拿前后两帧做差，把「刚跑完的那些」讲出来。通知本身归宿主
 * （Electron 的 Notification），这一层不碰。
 *
 * 起跑时已经在跑的那几条不算「刚跑完」：订阅装上的那一刻把当前集合当作基线，
 * 否则开窗后第一帧就会为上一次运行补一堆通知。
 */
export function watchCompletionNotifications(
  conversation: ConversationRuntime,
  mainWindow: Pick<MainWindowController, 'notify'>,
  titles: { readonly titleOf: (threadId: string) => string },
  report: (cause: unknown) => void,
): () => void {
  let previous: ReadonlySet<string> | null = null

  return conversation.transcripts.subscribeRunning(() => {
    const running = conversation.transcripts.runningSnapshot()

    if (previous === null) {
      previous = running
      return
    }

    const finished = [...previous].filter((threadId) => !running.has(threadId))

    previous = running

    for (const threadId of finished) {
      void mainWindow.notify({ title: '对话已完成', body: titles.titleOf(threadId) }).catch(report)
    }
  })
}
