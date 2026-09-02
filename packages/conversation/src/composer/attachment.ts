export interface ComposerAsset {
  readonly sessionToken: string
  readonly assetToken: string
  readonly url: string
  readonly filename: string
  readonly mediaType: string
}

export interface AttachmentUpload {
  readonly bytes: Uint8Array
  readonly filename: string
}

/** Consumer-owned port for assets entering a prompt draft. */
export interface AttachmentIntake {
  readonly pick: (multiple: boolean) => Promise<readonly ComposerAsset[]>
  readonly watchDrop: (onDropped: (assets: readonly ComposerAsset[]) => void) => () => void
  readonly paste: (input: AttachmentUpload) => Promise<ComposerAsset>
  readonly discard: (asset: ComposerAsset) => void
}
