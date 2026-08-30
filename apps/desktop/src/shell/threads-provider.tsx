import type { SessionControlsFailureReport } from '@poietica/conversation'
import { SessionControlsStore, ThreadsStore, TranscriptStore } from '@poietica/conversation'
import { SessionControlsContext, TranscriptsContext } from '@poietica/conversation-ui'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import type { DesktopAgentRuntime } from '../entry/agent-runtime'
import { defaultWorkspaceId, defaultWorkspaceReady } from '../entry/workspace-root'
import { ThreadsContext } from './threads-context'

/*
 * 这个模块只导出组件（类型导出在运行时不存在，不影响）。
 * 理由见 threads-context.ts 的顶部。
 */

export interface ThreadsProviderProps {
  readonly agent: Pick<
    DesktopAgentRuntime,
    'permissionPosture' | 'sessionConfig' | 'sessionUsage' | 'threads'
  >
  readonly children: ReactNode
  /**
   * 会话那一侧的失败往哪里说一声。
   *
   * 由组合根交进来，不在这里就地 import 失败策略：这个 Provider 的职责是把这几台
   * store 建出来并让它们与树同寿，「一次失败算不算降级」是应用的政策。
   */
  readonly report: SessionControlsFailureReport
}

/** Holds the shared conversation state for everything below it. */
export function ThreadsProvider({ agent, children, report }: ThreadsProviderProps) {
  /*
   * 三台 store 在这里建出来，一棵树一份。
   *
   * 组合根是它们唯一见面的地方：对话的记录、会话的可调项、对话的经过，各自有自己的
   * 状态和自己的读者，谁都不持有谁；它们之间那两根线也只在这里连（下面的 effect）。
   * 端口只造一次，两台共用同一个实例 —— 会话是在 port.open() 里诞生的，两台若各拿
   * 一个连接，那句「这条对话握着哪个会话」就会有两个答案。
   *
   * 必须是 useState 的初始化函数，不是 useMemo：useMemo 是性能优化，React 允许丢弃
   * 缓存重算，而这几台 store 都有身份（一条订阅、一段重放），换一个实例就等于让用户
   * 手里的对话经过凭空消失。
   */
  const [{ controls, store, transcripts }] = useState(() => {
    const port = agent.threads

    /* 帧日志那三次读取由组合根接上：store 不摸任何端口，也就脱离进程可测。 */
    const transcriptStore = new TranscriptStore({
      reads: {
        earlier: port.earlierFrames,
        outline: port.outline,
        until: port.framesUntil,
      },
    })

    return {
      controls: new SessionControlsStore({
        config: agent.sessionConfig,
        port,
        posture: agent.permissionPosture,
        report,
        transcripts: transcriptStore,
        usage: agent.sessionUsage,
      }),
      store: new ThreadsStore({ defaultWorkspaceId, port }),
      transcripts: transcriptStore,
    }
  })

  useEffect(() => {
    /*
     * 打开一条对话拿回来的那份答复，从对话那一侧流向会话与经过这一侧。
     *
     * 只有这一根线，而且是单向的：ThreadsStore 说「开了一条，这是全部」，谁认得其中
     * 哪一段谁自己接。删除同理 —— 说得出「这条没了」的只有它，跟着作废什么由各自决定。
     */
    const stopOpened = store.onOpened(controls.opened)

    const stopRemoved = store.onRemoved((threadId) => {
      controls.forget(threadId)
      transcripts.forget(threadId)
    })

    /*
     * 听 agent 自己报选择器。订阅与退订在同一个 effect 里成对出现，所以这
     * 个 Provider 装载几次就配平几次。
     */
    const stopReports = controls.start()

    /*
     * 第一次启动，主目录还在解析（workspace-root 的 defaultWorkspaceReady）：
     * 等它落定再读第一遍列表，没记下目录的存量一次就进对组，不会先落进
     * 哨兵组再跳一次。缓存命中时这个 Promise 已经兑现，与原来同帧。
     */
    void defaultWorkspaceReady().then(() => store.refresh())

    return () => {
      stopOpened()
      stopRemoved()
      stopReports()
    }
  }, [controls, store, transcripts])

  return (
    <TranscriptsContext value={transcripts}>
      <SessionControlsContext value={controls}>
        <ThreadsContext value={store}>{children}</ThreadsContext>
      </SessionControlsContext>
    </TranscriptsContext>
  )
}
