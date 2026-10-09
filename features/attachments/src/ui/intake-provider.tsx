import {
  type AttachmentIntake,
  AttachmentIntakeContext,
  type AttachmentUpload,
  type ComposerAsset,
} from '@poietica/feature-conversation/ui-api'
import type { ReactNode } from 'react'
import type { Attachment } from '../contract'
import type { AttachmentsApi } from './api'

/*
 * 附件的入库口（legacy `apps/desktop/src/assistant/attachment-intake.ts` 的当前形态）。
 *
 * legacy 的 createAttachmentIntake 直接调 native-bridge 的资产库；新架构里那条路换成
 * attachments 契约与 platform 的对话框（07 页 §4C/§4E）：
 *   importPaths  → attachments.importPaths
 *   paste         → attachments.importData
 *   pick          → platform dialog.pickFiles → attachments.importPaths
 *   watchDrop     → 空缺（拖放进来的文件走输入框自己的 drop 处理器，07 页 §4E）
 *   discard       → 空缺（字节的生命周期由 core 侧的回收策略管，前端只交回卡片）
 *
 * 两个字段在新契约里没有对应物，如实给空值而不编一个：
 *   sessionToken 在 legacy 是资产会话号（新契约没有会话这一层）；
 *   size 在 legacy 是进门那份收据（新契约的 Attachment 带 size，直接用）。
 */

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

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
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
          'image/png',
          base64Of(input.bytes),
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
