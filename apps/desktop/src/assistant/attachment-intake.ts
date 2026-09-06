import type { AttachmentIntake, ComposerAsset } from '@poietica/conversation'
import {
  type AssetFormat,
  importAssets,
  listAssetFormats,
  openAssetSession,
  removeAsset,
  uploadAsset,
} from '@poietica/native-bridge/assets'
import { pickPaths, watchDroppedPaths } from '@poietica/native-bridge/assets/dialog'
import { basename } from '@poietica/native-bridge/workspace/paths'
import { warn } from '@poietica/problem'

/* 种类在屏幕上叫什么。种类本身由原生那张表定义，这里只管翻译。 */
const KIND_LABELS: Readonly<Record<string, string>> = { image: '图片', text: '文本' }

/** 同一批 paths 在这么久之内再来一次，当作重复触发。 */
const REPEAT_WINDOW = 1000

export function createAttachmentIntake(): AttachmentIntake {
  let opened: Promise<string> | undefined
  let offered: Promise<readonly AssetFormat[]> | undefined

  const composerSession = (): Promise<string> => {
    if (opened === undefined) {
      const pending = openAssetSession()
      opened = pending
      void pending.catch(() => {
        if (opened === pending) {
          opened = undefined
        }
      })
    }
    return opened
  }

  const knownFormats = (): Promise<readonly AssetFormat[]> => {
    if (offered === undefined) {
      const pending = listAssetFormats()
      offered = pending
      void pending.catch(() => {
        if (offered === pending) {
          offered = undefined
        }
      })
    }
    return offered
  }

  const intake = async (paths: readonly string[]): Promise<readonly ComposerAsset[]> => {
    if (paths.length === 0) {
      return []
    }

    const sessionToken = await composerSession()
    const [stored, filenames] = await Promise.all([
      importAssets(sessionToken, paths),
      Promise.all(paths.map((path) => basename(path))),
    ])

    return stored.map((asset, index) => ({
      sessionToken,
      assetToken: asset.assetToken,
      url: asset.source,
      filename: filenames[index] ?? asset.assetToken,
      mediaType: asset.contentType,
    }))
  }

  const discard = (asset: ComposerAsset): void => {
    void removeAsset(asset.sessionToken, asset.assetToken).catch((cause: unknown) => {
      warn('暂存附件未能释放', { scope: 'attachment-intake', cause })
    })
  }

  return {
    import: intake,

    async pick(multiple) {
      /* 两件事互不依赖，串着等没有理由。第二次起清单已经在手，这里就只剩
      模块加载那一下。 */
      const formats = await knownFormats()

      const picked = await pickPaths({
        multiple,
        filters: [...new Set(formats.map((format) => format.kind))].map((kind) => ({
          name: KIND_LABELS[kind] ?? kind,
          extensions: formats
            .filter((format) => format.kind === kind)
            .flatMap((format) => format.extensions),
        })),
      })

      if (picked === null) {
        return []
      }

      return intake(picked)
    },

    watchDrop(onDropped) {
      let cancelled = false
      let stop: (() => void) | null = null
      let last = ''
      let reset: ReturnType<typeof setTimeout> | undefined

      void watchDroppedPaths((paths) => {
        if (cancelled) {
          return
        }

        const signature = paths.join('\u0000')

        if (signature === last) {
          return
        }

        last = signature

        if (reset !== undefined) {
          clearTimeout(reset)
        }
        reset = setTimeout(() => {
          if (last === signature) {
            last = ''
          }
        }, REPEAT_WINDOW)

        void intake(paths).then(
          (assets) => {
            if (cancelled) {
              for (const asset of assets) {
                discard(asset)
              }
              return
            }
            onDropped(assets)
          },
          (cause: unknown) => {
            warn('拖放附件未能接收', { scope: 'attachment-intake', cause })
          },
        )
      })
        .then((unlisten) => {
          if (cancelled) {
            unlisten()

            return
          }

          stop = unlisten
        })
        .catch((cause: unknown) => {
          warn('拖放监听未能安装', { scope: 'attachment-intake', cause })
        })

      return () => {
        cancelled = true
        if (reset !== undefined) {
          clearTimeout(reset)
          reset = undefined
        }
        stop?.()
        stop = null
      }
    },

    async paste(input) {
      const sessionToken = await composerSession()
      const stored = await uploadAsset(sessionToken, input.bytes.toBase64())

      return {
        sessionToken,
        assetToken: stored.assetToken,
        url: stored.source,
        filename: input.filename.length > 0 ? input.filename : `pasted-${crypto.randomUUID()}`,
        mediaType: stored.contentType,
      }
    },

    discard,
  }
}
