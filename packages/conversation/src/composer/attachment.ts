export interface ComposerAssetContext {
  readonly kind: 'browser-element'
  readonly label: string
}

export interface ComposerAsset {
  readonly sessionToken: string
  readonly assetToken: string
  readonly url: string
  readonly filename: string
  readonly mediaType: string
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
