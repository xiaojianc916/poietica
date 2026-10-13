import { type WindowCloseGuard, WindowCloseToken } from '@poietica/feature-platform/ui-api'
import { createId, type Disposable } from '@poietica/foundation'
import { builtinPoints } from '@poietica/ui-kernel'
import { FileText, MessageSquareText } from 'lucide-react'
import { ConversationUiToken, SkillDocumentToken, toolCallRenderers } from '../../ui-api'
import { AuxiliaryComposer } from '../components/composer/auxiliary-composer'
import { SkillDocumentPane } from '../components/skill-document-pane'
import { SKILL_DOCUMENT_PANEL, toggleSkillDocument } from '../components/skill-document-store'
import { createWidgetCard } from '../components/timeline/widget-card'
import { ConversationProviders } from '../composition'
import { confirmQuit } from '../session/notify'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'

/** 关窗守卫，以及 SkillDocumentToken、ConversationUiToken 等服务的提供。 */
export function createConversationServices(setup: ConversationSetup, actions: ConversationActions): void {
  const { ctx, dialogs, layout, platform, posture, skillDocuments, stores, transcripts } = setup
  const { activeThreadId, draftPin, openThread, runningThreadIds, subscribeActive } = actions

  // 退出拦截：有运行中的对话就先确认
  const guard = ctx.services.get(WindowCloseToken) as WindowCloseGuard
  ctx.lifecycle.onDispose(
    guard.onCloseRequested(async () => {
      const ok = await confirmQuit(dialogs, runningThreadIds().size)
      if (ok) await platform.call('app.quit', {}).catch(() => undefined)
      return ok
    }).dispose,
  )

  // ui-api：给其它功能的服务
  /*
   * 「打开右坞的哪一格」由 LayoutService 说，「看的是哪一份」由上面那个值说。面板**第一次被打开时才贡献**：那一格是随文档现开的，
   * 没有一个「还没打开就摆在标签条上」的常驻标签；贡献点里的 title 是常量，所以标签名固定写「技能文档」（已知差距，偏差 23）。
   */
  let skillDocumentPanel: Disposable | undefined
  ctx.services.provide(SkillDocumentToken, {
    open: (document) => {
      toggleSkillDocument(layout, skillDocuments, document, () => {
        /* 只能贡献一次：ContributionRegistry.add 见到重复 id 会抛 conflict（同一份面板注册两遍是编程错误）。 */
        if (skillDocumentPanel === undefined) {
          skillDocumentPanel = ctx.contribute(builtinPoints.panels, {
            id: SKILL_DOCUMENT_PANEL,
            location: 'right',
            order: 30,
            title: '技能文档',
            icon: FileText,
            /* 只由打开文档的人带进来，不出现在启动器 / 加号菜单里。 */
            offer: false,
            component: () => <SkillDocumentPane store={skillDocuments} />,
          })
        }
      })
    },
  })

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

  /* 对话内组件（R-18）：send 直接按用户消息提交，不经输入框 —— 用户正在打的字不受影响；提交失败就把那句话放回输入框。 */
  ctx.contribute(toolCallRenderers, {
    toolName: 'show_widget',
    component: createWidgetCard({
      send: (threadId, text) => {
        void stores.api
          .submit({ threadId, clientTurnId: createId(), text, attachmentIds: [], skills: [], deliverAs: 'turn' })
          .catch(() => {
            stores.composerFor(threadId).insertText(text)
          })
      },
      draft: (threadId, text) => {
        stores.composerFor(threadId).insertText(text)
      },
      openExternal: (url) => {
        void platform.call('shell.openExternal', { url })
      },
    }),
  })

  ctx.services.provide(ConversationUiToken, {
    activeThreadId,
    subscribeActive,
    runningCount: () => runningThreadIds().size,
    openThread,
    activeComposer: () => {
      const handle = stores.composerFor(activeThreadId())
      return {
        threadId: handle.threadId,
        addAttachments: handle.addAttachments,
        insertText: handle.insertText,
        submit: () => {
          handle.submit('turn')
        },
      }
    },
    draftAttachments: {
      ids: draftPin.view.ids,
      subscribe: (listener) => {
        return draftPin.view.subscribe(listener)
      },
      drop: draftPin.view.drop,
    },
  })
}
