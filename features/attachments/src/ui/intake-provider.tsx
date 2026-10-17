import {
  type AttachmentIntake,
  AttachmentIntakeContext,
  type AttachmentUpload,
  type ComposerAsset,
} from '@poietica/feature-conversation/ui-api'
import type { ReactNode } from 'react'
import type { Attachment } from '../contract'
import type { AttachmentsApi } from './api'

/* 附件的入库口。legacy 的 createAttachmentIntake 直接调 native-bridge 的资产库；新架构换成 attachments 契约与 platform 的对话框：
 * importPaths / paste / pick 分别落到 attachments.importPaths、attachments.importData 与 platform 的
 * dialog.pickFiles。watchDrop 与 discard 空缺（前者走输入框自己的 drop 处理器，后者的字节生命周期由 core 侧回收策略管）。 */

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

export interface AttachmentIntakeOptions {
  readonly api: AttachmentsApi
  readonly pickFiles: (multiple: boolean) => Promise<readonly string[]>
  readonly multiple: boolean
}

export function createAttachmentIntake(options: AttachmentIntakeOptions): AttachmentIntake {
  const { api, multiple, pickFiles } = options

  const importPaths = async (paths: readonly string[]): Promise<readonly ComposerAsset[]> => {
    if (paths.length === 0) {
      return []
    }
    return (await api.importPaths(paths)).map(assetOf)
  }

  return {
    importPaths,
    pick: async () => importPaths(await pickFiles(multiple)),
    watchDrop: () => () => undefined,
    paste: async (input: AttachmentUpload) =>
      assetOf(
        await api.importData(
          input.filename.length > 0 ? input.filename : '粘贴的图片.png',
          input.mime,
          input.bytes.toBase64(),
        ),
      ),
    discard: () => undefined,
  }
}

export function AttachmentIntakeProvider({
  children,
  intake,
}: {
  readonly children: ReactNode
  readonly intake: AttachmentIntake
}): ReactNode {
  return <AttachmentIntakeContext value={intake}>{children}</AttachmentIntakeContext>
}
