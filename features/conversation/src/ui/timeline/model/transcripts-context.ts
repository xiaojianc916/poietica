import { invariant } from '@poietica/foundation'
import { createContext, useContext } from 'react'
import type { TranscriptStore } from './transcript-store'

/*
 * 实例由组合根造出来，经 Context 交给下面所有人，useSyncExternalStore 订的是拿到手的那一个，不是 import 来的那一个 —— 模块级实例会让用例之间互相留痕。
 * **没有默认实例**：拿不到就是接线漏了，那要当场说出来，而不是让半棵组件树安静地对着另一份永远不会更新的空转录。
 */
export const TranscriptsContext = createContext<TranscriptStore | null>(null)

export function useTranscripts(): TranscriptStore {
  const store = useContext(TranscriptsContext)

  if (store === null) {
    invariant(false, '这棵组件树上没有 TranscriptsContext，转录无处可读。')
  }

  return store
}
