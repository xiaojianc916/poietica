import type { AgentSessionPort } from '@poietica/agent-contract'
import { useSessionControlsActions, useTranscripts } from '@poietica/agent-ui'
import { createAutomationStore, sessionConfigOf } from '@poietica/automations'
import type { Automation } from '@poietica/native-bridge'
import { useEffect } from 'react'
import { v7 as uuidv7 } from 'uuid'

import { useThreadsActions } from '../assistant/threads-context'

/**
 * 自动化的进程级运行时。
 *
 * 一个进程一份，和 agent 会话、方言、对话列表同级（见 assistant/agent-runtime.ts）。
 */
export const automationStore = createAutomationStore()

export interface AutomationDispatcherProps {
  readonly session: AgentSessionPort
}

/**
 * 「到期时做什么」的挂载点。
 *
 * 它不调度 —— 表在原生侧走（src-tauri 的 commands/automations.rs）。这里只做一件
 * 事：把 dispatch 交给 store，并让那条订阅与应用同寿。挂在自动化那一格里的话，人
 * 切走标签页就没人接到期了 —— 而那正好是自动化唯一的意义所在。
 *
 * 必须挂在 ThreadsProvider 之内：一次运行要开出一条对话，而开对话的动作出自那个
 * provider。
 *
 * 注入在这里，不在 @poietica/automations 里：那一层不认识 agent，也不认识工作台。
 * 一次运行就是开出一条普通对话、把指令说进去 —— 说话与人按下发送键走的是同一条
 * 管线（TranscriptStore.send），自动化不另立一套执行器，也不另存一份运行日志。
 */
export function AutomationDispatcher({ session }: AutomationDispatcherProps) {
  const controls = useSessionControlsActions()
  const threads = useThreadsActions()
  const transcripts = useTranscripts()

  useEffect(() => {
    const dispatch = async (
      automation: Automation,
    ): Promise<{ readonly threadId: string | null; readonly outcome: 'succeeded' | 'failed' }> => {
      /* 对话的身份由这里铸好再交给平台；开不出来才算失败。 */
      const threadId = uuidv7()
      const opened = await threads.create(threadId)

      if (opened === null) {
        return { threadId: null, outcome: 'failed' }
      }

      /*
       * 先起名，再开口，顺序不能反。
       *
       * 名字走 ThreadsStore.rename —— 界面上「重命名」那条唯一的写路径，落库
       * 时是 manual；而 record_prompt 只在标题还是 fallback 时才从第一句话里
       * 取名（crates/persistence 的 threads.rs）：先到一步的 manual，从此任何
       * 派生名都顶不掉。先开口，这条对话就叫那句话了。
       */
      await threads.rename(threadId, automation.title)

      /*
       * 这条自动化要的会话设置，只下发到它自己开出来的这条对话。
       *
       * 走会话那个 scope，不走 agent 那个：后者是这一家 agent 的默认值，改它会落到
       * config.toml 的 default_model 上，也就是改掉人此刻正在用的模型 —— 一次后台
       * 到期不该有那种权限。作用域正好就是这一次运行。
       *
       * 它是尽力而为的：agent 可以拒绝、改名或撤回某个取值，失败由会话那一侧按对话
       * 记下来（selectorFailureOf），这里不替它兜底，也不假装设过。
       */
      for (const [controlId, value] of Object.entries(sessionConfigOf(automation))) {
        controls.selectControl(threadId, controlId, value)
      }

      /*
       * 指令从唯一的发送管线进去（TranscriptStore.send → AgentSessionPort.prompt），
       * 与人打字发送同一条路：先上屏、再接帧流、再发出去。
       *
       * onUserMessage 报自动化的名字而不是指令原文：侧栏的乐观标题与库里的
       * manual 名是同一个词，下一次整表读取不会把名字换掉。不 openConversation：
       * 一次后台到期不该抢走人正在看的那一格 —— 跑完之后从「最近运行」那一列
       * 点进去，才是人自己决定要看它。
       */
      transcripts.send({
        assets: [],
        configuration: [],
        onUserMessage: (_threadId, said) => {
          threads.noteUserMessage(said, automation.title)
        },
        port: session,
        skills: [],
        text: automation.prompt,
        threadId,
      })

      const terminal = await transcripts.waitForTerminal(threadId)

      return {
        threadId,
        outcome: terminal === 'completed' ? 'succeeded' : 'failed',
      }
    }

    return automationStore.start(dispatch)
  }, [controls, session, threads, transcripts])

  return null
}
