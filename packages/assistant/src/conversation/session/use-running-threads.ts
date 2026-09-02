import { useSyncExternalStore } from 'react'
import { useTranscripts } from './transcripts-context'

/**
 * 正在跑的那些对话。
 *
 * 真相在 TranscriptStore（每条转录的 timeline.status），这里只把它接进组件树。
 * 集合的引用只在成员变化时更换，所以流式期间的每一帧都叫不醒任何订阅者。
 */
export function useRunningThreads(): ReadonlySet<string> {
  const transcripts = useTranscripts()

  return useSyncExternalStore(
    transcripts.subscribeRunning,
    transcripts.runningSnapshot,
    transcripts.runningSnapshot,
  )
}
