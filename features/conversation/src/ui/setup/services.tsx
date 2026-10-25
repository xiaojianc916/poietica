import { WindowCloseToken } from '@poietica/feature-platform/ui-api'
import { createId } from '@poietica/foundation'
import { builtinPoints, isSettingsDockOwner, useFeatureStore, useLayout, useObservable } from '@poietica/ui-kernel'
import { Bot, MessageSquareText } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { type ComposerDraft, ConversationUiToken } from '../../ui-api'
import { AuxiliaryComposer } from '../composer'
import { ConversationProviders } from '../composition'
import { confirmQuit, hiddenModelsOf, sessionConfigControlsOf, withoutHiddenModels } from '../session'
import { createSubagentDockTabs, SUBAGENT_PANEL_ID, SubagentDockPanel, subagentTitleOf } from '../timeline'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'

/** 关窗守卫，以及 ConversationUiToken 等服务的提供。 */
export function createConversationServices(setup: ConversationSetup, actions: ConversationActions): void {
  const { api, ctx, dialogs, layout, liveComposers, posture, prefs, side, stores, subagentTabs, transcripts } = setup
  const { activeThreadId, openThread, runningThreadIds, subscribeActive } = actions

  // 退出拦截：有运行中的对话就先确认。只答「放不放行」——真正的 app.quit 由守卫在所有处理器放行后统一发起，
  // 处理器自己再发一次会让后面的处理器还没被问到就开始退出。
  const guard = ctx.services.get(WindowCloseToken)
  ctx.lifecycle.onDispose(
    guard.onCloseRequested(async () => await confirmQuit(dialogs, runningThreadIds().size)).dispose,
  )

  /* 辅助对话里换模型 / 档位：就是这条对话的那两格（与主对话工具条同一条路，失败时重读控件表） */
  const selectSideControl = (threadId: string, controlId: string, value: string): void => {
    const handle = stores.composerFor(threadId)
    if (controlId === 'thought') {
      handle.setThinking(value)
      return
    }
    const at = value.indexOf('/')
    if (controlId === 'model' && at > 0) handle.setModel({ provider: value.slice(0, at), id: value.slice(at + 1) })
  }

  /* 右坞的格归哪条对话就问哪条对话（坞按对话分账；设置页的坞不收这一格，归属是 settings:* 时当作没有对话） */
  const SideChatPanel = () => {
    const owner = useLayout().auxiliary.owner
    const threadId = owner === null || isSettingsDockOwner(owner) ? null : owner
    const controls = useFeatureStore(stores.controls.store, (s) =>
      threadId === null ? undefined : s.byThread[threadId],
    )
    const hiddenModels = hiddenModelsOf(useObservable(prefs))
    /* 侧边一问不动手：只留模型与思考档位，批准方式 / 计划 / 目标都不进这一格 */
    const shown = useMemo(
      () =>
        withoutHiddenModels(sessionConfigControlsOf(controls), hiddenModels).filter(
          (control) => control.purpose === 'model' || control.purpose === 'thought',
        ),
      [controls, hiddenModels],
    )
    const missing = threadId !== null && controls === undefined
    useEffect(() => {
      if (missing && threadId !== null) void stores.controls.refresh(threadId)
    }, [missing, threadId])
    return (
      <AuxiliaryComposer
        controls={shown}
        onInsert={(id, text) => draftOf(id).insertText(text)}
        onSelectControl={(controlId, value) => {
          if (threadId !== null) selectSideControl(threadId, controlId, value)
        }}
        side={side}
        threadId={threadId}
      />
    )
  }

  /* 右坞第一格：辅助对话（omp 的 /btw 侧边提问）。order 5 让它排在审查（10）/ 终端（15）/ 浏览器（20）之前。 */
  ctx.contribute(builtinPoints.panels, {
    id: 'conversation.auxiliary',
    location: 'right',
    order: 5,
    title: '辅助对话',
    icon: MessageSquareText,
    component: SideChatPanel,
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

  /*
   * 「这条对话的输入框」：屏幕上挂着的那一格优先（插字、加附件、提交都与手打一句话同一条路）；
   * 没挂在屏幕上（切走了、入口页）才退回草稿模型。
   */
  const draftOf = (threadId: string | null): ComposerDraft => {
    const live = threadId === null ? undefined : liveComposers.get(threadId)
    if (live !== undefined) return live
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
