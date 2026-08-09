import { ThreadsStore, TranscriptStore } from '@poietica/agent'
import { TranscriptsContext } from '@poietica/agent-ui'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { defaultWorkspaceId, defaultWorkspaceReady } from '../workspace-root'
import { desktopSessionConfig, desktopThreads } from './agent-session'
import { ThreadsContext } from './threads-context'

/*
 * 这个模块只导出组件（类型导出在运行时不存在，不影响）。
 * 理由见 threads-context.ts 的顶部。
 */

export interface ThreadsProviderProps {
  readonly children: ReactNode
}

/** Holds the shared conversation state for everything below it. */
export function ThreadsProvider({ children }: ThreadsProviderProps) {
  /*
   * 两个 store 在这里成对建出来，一棵树一份。
   *
   * 它们本来就是一件事的两半：一条对话持有一个会话，选择器由那个会话说出来（侧栏、
   * 标签、输入框旁的选择器读的都是它）；而打开这条对话会把它的经过一起带回来 ——
   * 那是 agent 在 session/load 期间重放的帧，这段历史没有第二个来源。
   *
   * 必须是 useState 的初始化函数，不是 useMemo：useMemo 是性能优化，React 允许丢弃
   * 缓存重算，而这两个 store 都有身份（一条订阅、一段重放），换一个实例就等于让用户
   * 手里的对话经过凭空消失。
   */
  const [{ store, transcripts }] = useState(() => {
    const transcriptStore = new TranscriptStore()

    return {
      store: new ThreadsStore({
        config: desktopSessionConfig(),
        defaultWorkspaceId,
        port: desktopThreads(),
        transcripts: transcriptStore,
      }),
      transcripts: transcriptStore,
    }
  })

  useEffect(() => {
    /*
     * 第一次启动，主目录还在解析（workspace-root 的 defaultWorkspaceReady）：
     * 等它落定再读第一遍列表，没记下目录的存量一次就进对组，不会先落进
     * 哨兵组再跳一次。缓存命中时这个 Promise 已经兑现，与原来同帧。
     */
    void defaultWorkspaceReady().then(() => store.refresh())

    /*
     * 听 agent 自己报选择器。订阅与退订在同一个 effect 里成对出现，所以这
     * 个 Provider 装载几次就配平几次。
     */
    return store.start()
  }, [store])

  return (
    <TranscriptsContext value={transcripts}>
      <ThreadsContext value={store}>{children}</ThreadsContext>
    </TranscriptsContext>
  )
}
