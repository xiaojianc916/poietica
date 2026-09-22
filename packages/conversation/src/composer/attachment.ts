export interface ComposerAssetContext {
  readonly kind: 'browser-element'
  readonly label: string
}

export interface ComposerAsset {
  readonly sessionToken: string
  readonly assetToken: string
  /** image：资产协议预览地址；file：空字符串（通用文件没有预览，只渲染卡片）。 */
  readonly url: string
  readonly filename: string
  readonly mediaType: string
  /** 字节数，文件卡片那一行「类型 大小」用；图片也带着，来源同一份收据。 */
  readonly size: number
  /** image 进内存注册表走预览；file 是暂存在原生侧的通用文件，发 file part。 */
  readonly kind: 'image' | 'file'
  readonly context?: ComposerAssetContext
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
