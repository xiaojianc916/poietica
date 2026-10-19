import { createContext, useContext } from 'react'

/*
 * 输入框草稿里那批资产的形状，以及「谁来把它们弄进来」的接口。
 *
 * 两样都是输入框自己的事：入库口由 ui/setup/attachments.tsx 用 attachments 的 `AttachmentsUiToken`
 * 拼出来、经 composerProviders 注入输入框树。attachments 不认识这里的任何一个名字（它只交自己的
 * `Attachment` 实体），所以它们不进 ui-api。
 *
 * **迁移自** legacy `packages/conversation/src/composer/attachment.ts` 与
 * `apps/desktop/src/assistant/attachment-intake.ts`：字段与语义一字未改。
 */

export interface ComposerAssetContext {
  readonly kind: 'browser-element'
  readonly label: string
}

export interface ComposerAsset {
  readonly sessionToken: string
  readonly assetToken: string
  /** image：资产协议预览地址；file：空字符串。 */
  readonly url: string
  readonly filename: string
  readonly mediaType: string
  /** 字节数，来自进门那份收据。 */
  readonly size: number
  /** image 进内存注册表走预览；file 是暂存在原生侧的通用文件，发 file part。 */
  readonly kind: 'image' | 'file'
  readonly context?: ComposerAssetContext
}

/**
 * 通用文件与元素上下文在正文里是一枚记号，发不发它由那枚记号说了算：字节仍住在
 * 附件册，记号被删掉就不再随行。图片不走这条，它留在输入框上沿那排缩略图里。
 */
export function isInlineAttachment(asset: ComposerAsset): boolean {
  return asset.kind === 'file' || asset.context?.kind === 'browser-element'
}

export interface AttachmentUpload {
  readonly bytes: Uint8Array
  readonly filename: string
  /** 入库按它分类：image 会走预览，其余落成 file。 */
  readonly mime: string
}

/** Consumer-owned port for assets entering a prompt draft. */
export interface AttachmentIntake {
  readonly importPaths: (paths: readonly string[]) => Promise<readonly ComposerAsset[]>
  readonly pick: (multiple: boolean) => Promise<readonly ComposerAsset[]>
  readonly watchDrop: (onDropped: (assets: readonly ComposerAsset[]) => void) => () => void
  readonly paste: (input: AttachmentUpload) => Promise<ComposerAsset>
  readonly discard: (asset: ComposerAsset) => void
}

export const AttachmentIntakeContext = createContext<AttachmentIntake | null>(null)

export function useAttachmentIntake(): AttachmentIntake | null {
  return useContext(AttachmentIntakeContext)
}
