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
}

/** Consumer-owned port for assets entering a prompt draft. */
export interface AttachmentIntake {
  readonly import: (paths: readonly string[]) => Promise<readonly ComposerAsset[]>
  readonly pick: (multiple: boolean) => Promise<readonly ComposerAsset[]>
  readonly watchDrop: (onDropped: (assets: readonly ComposerAsset[]) => void) => () => void
  readonly paste: (input: AttachmentUpload) => Promise<ComposerAsset>
  readonly discard: (asset: ComposerAsset) => void
}
