import { WindowCloseToken } from '@poietica/feature-platform/ui-api'
import { createId } from '@poietica/foundation'
import { builtinPoints } from '@poietica/ui-kernel'
import { Bot, MessageSquareText } from 'lucide-react'
import { type ComposerDraft, ConversationUiToken } from '../../ui-api'
import { AuxiliaryComposer } from '../composer/view/auxiliary-composer'
import { ConversationProviders } from '../composition'
import { confirmQuit } from '../session/notify'
import { subagentTitleOf } from '../timeline/view/delegate-channel-view'
import { createSubagentDockTabs, SUBAGENT_PANEL_ID, SubagentDockPanel } from '../timeline/view/subagent-dock'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'

/** 关窗守卫，以及 ConversationUiToken 等服务的提供。 */
export function createConversationServices(setup: ConversationSetup, actions: ConversationActions): void {
  const { api, ctx, dialogs, layout, posture, stores, subagentTabs, transcripts } = setup
  const { activeThreadId, openThread, runningThreadIds, subscribeActive } = actions

  // 退出拦截：有运行中的对话就先确认。只答「放不放行」——真正的 app.quit 由守卫在所有处理器放行后统一发起，
  // 处理器自己再发一次会让后面的处理器还没被问到就开始退出。
  const guard = ctx.services.get(WindowCloseToken)
  ctx.lifecycle.onDispose(
    guard.onCloseRequested(async () => await confirmQuit(dialogs, runningThreadIds().size)).dispose,
  )

  // ui-api：给其它功能的服务
  /* 右坞第一格：辅助对话。order 5 让它排在审查（10）/ 终端（15）/ 浏览器（20）之前；输入条要读会话上下文的工具名册，所以经 ConversationProviders 包一层。 */
  ctx.contribute(builtinPoints.panels, {
    id: 'conversation.auxiliary',
    location: 'right',
    order: 5,
    title: '辅助对话',
    icon: MessageSquareText,
    component: () => (
      <ConversationProviders posture={posture} transcripts={transcripts}>
        <AuxiliaryComposer />
      </ConversationProviders>
    ),
  })

  /*
   * 右坞「子代理」组（order 6，紧挨辅助对话）：每个标签是一个子代理的实时对话，带引导与停止。只能由代码打开（状态面板 / 工具卡上点子代理），
   * 所以不进启动器。转录读同一台 TranscriptStore 的 `thread#agent` 通道，引导 / 停止走 ConversationApi。
   */
  ctx.contribute(builtinPoints.panels, {
    id: SUBAGENT_PANEL_ID,
    location: 'right',
    order: 6,
    title: '子代理',
    icon: Bot,
    offer: false,
    dockTabs: createSubagentDockTabs({
      layout,
      store: subagentTabs,
      resolveTitle: (threadId, agentId) => subagentTitleOf(transcripts.read(threadId).timeline, agentId),
    }),
    component: () => (
      <ConversationProviders agentControls={api} posture={posture} transcripts={transcripts}>
        <SubagentDockPanel store={subagentTabs} />
      </ConversationProviders>
    ),
  })

  const draftOf = (threadId: string | null): ComposerDraft => {
    const handle = stores.composerFor(threadId)
    return {
      threadId: handle.threadId,
      addAttachments: handle.addAttachments,
      insertText: handle.insertText,
      submit: () => {
        handle.submit('turn')
      },
    }
  }

  ctx.services.provide(ConversationUiToken, {
    activeThreadId,
    subscribeActive,
    runningCount: () => runningThreadIds().size,
    openThread,
    activeComposer: () => draftOf(activeThreadId()),
    composerOf: (threadId) => draftOf(threadId),
    sendText: async (threadId, text) => {
      await stores.api.submit({
        threadId,
        clientTurnId: createId(),
        text,
        attachmentIds: [],
        skills: [],
        deliverAs: 'turn',
      })
    },
  })
}
