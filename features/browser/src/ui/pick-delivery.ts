import type { ComposerDraft } from '@poietica/feature-conversation/ui-api'
import type { NavigationService } from '@poietica/ui-kernel'
import type { PickedElement } from '../contract'
import type { BrowserApi } from './api'

/*
 * 拾取结果 → 输入框（07 页 §12E 的「拾取结果」一栏）。
 *
 * **迁移自** legacy `apps/desktop/src/browser/browser-pick.ts` 的语义，落点从「原生
 * 资产令牌 + 平台事件流」换成了新架构的三件东西：
 *
 *   attachments.importData(name, mime, base64)  →  附件（报告正文就是 Markdown）
 *   ConversationUiToken.activeComposer()        →  当前页面的输入框
 *   navigation.navigate('conversation.home')    →  没有输入框时先回入口页
 *
 * legacy 的两条保护在这里同样成立：交付前确认「当前输入框」还在（不在了就丢弃），
 * 以及一次拾取只产生一条提示词（提交这一步只发生一次）。
 */

export interface PickDeliveryDeps {
  /** `attachments.importData`（经 attachments 契约，见 ui/index.tsx 的接线） */
  readonly importData: (
    name: string,
    mime: string,
    base64: string,
  ) => Promise<{ id: string; name: string; kind: 'image' | 'file'; previewUrl: string | null }>
  readonly activeComposer: () => ComposerDraft | null
  readonly navigation: NavigationService
  readonly report: (message: string, cause?: unknown) => void
}

/** report 是 Markdown 正文：按 UTF-8 编成 base64 交给附件库。 */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

/** `<elementType>.md`：legacy 的命名法，标签就是文件主名。 */
export function reportName(elementType: string): string {
  const cleaned = elementType.trim().replace(/[\\/:*?"<>|]/gu, '-')

  return `${cleaned === '' ? 'element' : cleaned}.md`
}

export function createPickDelivery(deps: PickDeliveryDeps) {
  return {
    async deliver(picked: PickedElement): Promise<void> {
      try {
        const attachment = await deps.importData(
          reportName(picked.elementType),
          'text/markdown',
          utf8ToBase64(picked.report),
        )

        let draft = deps.activeComposer()

        if (draft === null) {
          /* 当前页面没有输入框（设置页…）：先回入口页再取一次。 */
          deps.navigation.navigate({ surface: 'conversation.home', params: {} })
          draft = deps.activeComposer()
        }

        if (draft === null) {
          deps.report('拾取结果没有输入框可去，丢弃')

          return
        }

        draft.addAttachments([
          { id: attachment.id, name: attachment.name, kind: attachment.kind, previewUrl: attachment.previewUrl },
        ])

        if (picked.comment !== '') {
          draft.insertText(picked.comment)
        }

        if (picked.submission === 'send') {
          draft.submit()
        }
      } catch (cause) {
        deps.report('元素报告未能交付', cause)
      }
    },
  }
}

export type PickDelivery = ReturnType<typeof createPickDelivery>

/** 取消进行中的拾取（面板里那枚按钮的第二态、换标签、隐藏面板都走它）。 */
export async function cancelPick(api: BrowserApi): Promise<void> {
  await api.cancelPick().catch(() => undefined)
}
