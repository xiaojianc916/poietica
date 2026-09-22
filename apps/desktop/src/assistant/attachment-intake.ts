import type { AttachmentIntake, ComposerAsset } from '@poietica/conversation'
import {
  importAssets,
  openAssetSession,
  removeAsset,
  uploadAsset,
} from '@poietica/native-bridge/assets'
import { pickPaths, watchDroppedPaths } from '@poietica/native-bridge/assets/dialog'
import { basename } from '@poietica/native-bridge/workspace/paths'
import { warn } from '@poietica/problem'

/**
 * 选择框只有一个「所有文件」过滤器：分类在选完之后由原生按文件头做
 * （图片走预览，其余按通用文件暂存），不在选择框里逼用户二选一。
 * 对标 deepseek-harness 的裸 <input type="file" multiple>（无 accept）。
 */
const ALL_FILES_FILTER = { name: '所有文件', extensions: ['*'] } as const

/** 同一批 paths 在这么久之内再来一次，当作重复触发。 */
const REPEAT_WINDOW = 1000

/**
 * 一次成型：同一件事在飞的时候再来就搭上那一次，不另起一次。
 *
 * 失败后必须把槽位放掉，否则一次网络抖动会让这条通道永远回不来。
 */
function once<T>(work: () => Promise<T>): () => Promise<T> {
  let held: Promise<T> | undefined

  return () => {
    if (held === undefined) {
      const pending = work()
      held = pending
      void pending.catch(() => {
        if (held === pending) {
          held = undefined
        }
      })
    }

    return held
  }
}

export function createAttachmentIntake(): AttachmentIntake {
  const composerSession = once(openAssetSession)

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
      size: asset.byteLength,
      kind: asset.kind,
    }))
  }

  const discard = (asset: ComposerAsset): void => {
    /* 通用文件不在注册表里（字节只落在 tmp 暂存根，启动对账清），这一趟没有意义。 */
    if (asset.kind === 'file') {
      return
    }

    void removeAsset(asset.sessionToken, asset.assetToken).catch((cause: unknown) => {
      warn('暂存附件未能释放', { scope: 'attachment-intake', cause })
    })
  }

  return {
    import: intake,

    async pick(multiple) {
      const picked = await pickPaths({
        multiple,
        filters: [ALL_FILES_FILTER],
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
        size: stored.byteLength,
        // 剪贴板这条路只可能是图片（截图没有路径，走 base64 上传）。
        kind: 'image',
      }
    },

    discard,
  }
}
