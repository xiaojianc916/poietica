import type { Attachment } from '@poietica/feature-attachments/contract'
import { AttachmentsUiToken } from '@poietica/feature-attachments/ui-api'
import type { ReactNode } from 'react'
import { type ComposerDraft, composerInputHandlers, composerProviders, type DraftAttachment } from '../../ui-api'
import { type AttachmentIntake, AttachmentIntakeContext, type ComposerAsset } from '../composer'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'

/* 附件进输入框：入库归 attachments（AttachmentsUiToken 只交它自己的 Attachment），画进草稿归这里。
 * 三处落点：composerProviders 把入库口注入输入框树（输入框左端那枚回形针**不在这里**：legacy 与基准截图 #03 都只有一枚加号）；
 * composerInputHandlers 接剪贴板与拖放，返回 true 表示事件已经被吃掉；草稿视图交给 trackDraftRefs 做引用登记。
 * watchDrop 与 discard 空缺（前者走输入框自己的 drop 处理器，后者的字节生命周期由 core 侧回收策略管）。 */

function assetOf(attachment: Attachment): ComposerAsset {
  return {
    assetToken: attachment.id,
    filename: attachment.name,
    kind: attachment.kind,
    mediaType: attachment.mime,
    sessionToken: '',
    size: attachment.size,
    url: attachment.previewUrl ?? '',
  }
}

function draftOf(attachment: Attachment): DraftAttachment {
  return { id: attachment.id, name: attachment.name, kind: attachment.kind, previewUrl: attachment.previewUrl }
}

export function createConversationAttachments(setup: ConversationSetup, actions: ConversationActions): void {
  const { ctx } = setup
  const attachments = ctx.services.get(AttachmentsUiToken)

  const intake: AttachmentIntake = {
    importPaths: async (paths) => (await attachments.importPaths(paths)).map(assetOf),
    /* 选文件框总是多选（与 legacy 的入库口一致，调用方传的参数不改变它）。 */
    pick: async () => (await attachments.pick(true)).map(assetOf),
    watchDrop: () => () => undefined,
    paste: async (input) => assetOf(await attachments.importData(input.filename, input.mime, input.bytes)),
    discard: () => undefined,
  }

  ctx.contribute(composerProviders, {
    id: 'conversation.attachments',
    order: 10,
    component: (({ children }: { readonly children: ReactNode }) => (
      <AttachmentIntakeContext value={intake}>{children}</AttachmentIntakeContext>
    )) as (props: { readonly children: ReactNode }) => ReactNode,
  })

  const addTo = (draft: ComposerDraft, imported: readonly Attachment[] | null): boolean => {
    if (imported === null) return false
    if (imported.length > 0) draft.addAttachments(imported.map(draftOf))
    return true
  }
  ctx.contribute(composerInputHandlers, {
    id: 'conversation.attachments',
    /* 超长文字必须在 Lexical 插入之前就认领：粘进去之后再抽出来，那一大段已经建过一次节点了。 */
    claims: (event) => attachments.claimsPaste(event),
    onPaste: async (event, draft) => addTo(draft, await attachments.fromPaste(event)),
    onDrop: async (event, draft) => addTo(draft, await attachments.fromDrop(event)),
  })

  ctx.lifecycle.onDispose(attachments.trackDraftRefs(actions.draftPin.view))
}
