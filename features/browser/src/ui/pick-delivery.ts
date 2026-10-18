import type { ComposerDraft } from '@poietica/feature-conversation/ui-api'
import type { NavigationService } from '@poietica/ui-kernel'
import type { PickedElement } from '../contract'
import type { BrowserApi } from './api'

/* 拾取结果 → 输入框。落点：attachments.importData → 附件（报告正文就是 Markdown）、
 * ConversationUiToken.activeComposer() → 当前输入框、navigation.navigate('conversation.home') → 没有
 * 输入框时先回入口页。两条保护：交付前确认「当前输入框」还在，一次拾取只产生一条提示词。 */

export interface PickDeliveryDeps {
  readonly importData: (
    name: string,
    mime: string,
    base64: string,
  ) => Promise<{ id: string; name: string; kind: 'image' | 'file'; previewUrl: string | null }>
  readonly activeComposer: () => ComposerDraft | null
  readonly navigation: NavigationService
  readonly report: (message: string, cause?: unknown) => void
}

export function utf8ToBase64(text: string): string {
  return new TextEncoder().encode(text).toBase64()
}

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

export async function cancelPick(api: BrowserApi): Promise<void> {
  await api.cancelPick().catch(() => undefined)
}
