import type { TranscriptStore } from '@poietica/conversation'
import { createContext, useContext } from 'react'

/*
 * 转录 store 由谁给。
 *
 * 这是 React 对「外部 store 接进组件树」给出的形状：实例由组合根造出来，经 Context
 * 交给下面所有人，useSyncExternalStore 订的是拿到手的那一个，不是 import 来的那一个。
 * 模块级实例做不到这件事 —— 模块随 import 求值一次，用例之间互相留痕，而「一个 store
 * 订着一条线路」那道守卫会变成进程级的。
 *
 * 同目录的 agent-controls-context 与 apps/desktop 的 threads-context 是同一个形制：
 * 导出 context 本体与读它的 hook，provider 就是 context —— React 19 起 <Context value>
 * 是官方形制。不导出别名：使用处写别名，全仓按官方形制搜就搜不到它。
 *
 * 没有默认实例：拿不到就是接线漏了，那要当场说出来，而不是让半棵组件树安静地对着
 * 另一份永远不会更新的空转录。
 */
export const TranscriptsContext = createContext<TranscriptStore | null>(null)

export function useTranscripts(): TranscriptStore {
  const store = useContext(TranscriptsContext)

  if (store === null) {
    throw new Error('这棵组件树上没有 TranscriptsContext，转录无处可读。')
  }

  return store
}
