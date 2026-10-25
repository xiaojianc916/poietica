import { ConversationUiToken, toolCallRenderers } from '@poietica/feature-conversation/ui-api'
import { BannersToken, defineUiFeature } from '@poietica/ui-kernel'
import { createIntelligentUiApi } from './api'
import { createIntelligentUiCard } from './card'

/*
 * 对话内智能界面：往 conversation 的 toolCallRenderers 贡献 intelligent_ui 的卡片。
 * `inline`：界面自己就是内容 —— 不并进过程组，轮次落定后也不折进「过程」（失败的那次照常归过程）。
 * send 直接按用户消息提交，不经输入框 —— 用户正在打的字不受影响；提交失败就把那句话放回输入框。
 * 状态读写走 intelligentUi.getState / setState：Core 按 callId 存，model 与 tweaks 在下一句话时交给模型。
 * 复制为图片走 Host；导出先经 platform 选路径，再由 Host 写 HTML。
 */
export default defineUiFeature({
  id: 'intelligent-ui',
  dependsOn: ['conversation', 'platform'],
  setup(ctx) {
    const conversation = ctx.services.get(ConversationUiToken)
    const banners = ctx.services.get(BannersToken)
    const api = createIntelligentUiApi(ctx)

    ctx.contribute(toolCallRenderers, {
      toolName: 'intelligent_ui',
      inline: true,
      component: createIntelligentUiCard({
        send: (threadId, text) => {
          void conversation.sendText(threadId, text).catch(() => {
            conversation.composerOf(threadId).insertText(text)
          })
        },
        draft: (threadId, text) => {
          conversation.composerOf(threadId).insertText(text)
        },
        openExternal: (url) => {
          void api.openExternal(url)
        },
        loadState: api.loadState,
        saveState: api.saveState,
        copyImage: api.copyImage,
        exportHtml: api.exportHtml,
        showInFolder: (path) => {
          void api.showInFolder(path)
        },
        banner: (banner) => {
          banners.show(banner)
        },
        bannerError: (cause, title) => {
          banners.error(cause, title)
        },
      }),
    })
  },
})
