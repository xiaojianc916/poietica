import { ConversationUiToken, toolCallRenderers } from '@poietica/feature-conversation/ui-api'
import { platformContract } from '@poietica/feature-platform/contract'
import { defineUiFeature } from '@poietica/ui-kernel'
import { createWidgetCard } from './widget-card'

/*
 * 对话内组件（审查 R-18）：往 conversation 的 toolCallRenderers 贡献 show_widget 的卡片。
 * `inline`：组件自己就是内容 —— 不并进过程组，轮次落定后也不折进「过程」（失败的那次照常归过程）。
 * send 直接按用户消息提交，不经输入框 —— 用户正在打的字不受影响；提交失败就把那句话放回输入框。
 */
export default defineUiFeature({
  id: 'widgets',
  dependsOn: ['conversation', 'platform'],
  setup(ctx) {
    const conversation = ctx.services.get(ConversationUiToken)
    const platform = ctx.rpc(platformContract)

    ctx.contribute(toolCallRenderers, {
      toolName: 'show_widget',
      inline: true,
      component: createWidgetCard({
        send: (threadId, text) => {
          void conversation.sendText(threadId, text).catch(() => {
            conversation.composerOf(threadId).insertText(text)
          })
        },
        draft: (threadId, text) => {
          conversation.composerOf(threadId).insertText(text)
        },
        openExternal: (url) => {
          void platform.call('shell.openExternal', { url })
        },
      }),
    })
  },
})
