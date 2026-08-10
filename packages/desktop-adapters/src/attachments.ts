import type { AttachmentIntake, ComposerAsset } from '@poietica/agent-ui'
import {
  type AssetFormat,
  importAssets,
  listAssetFormats,
  openAssetSession,
  removeAsset,
  uploadAsset,
} from '@poietica/ipc'

/*
 * 附件收件口的原生这一半。
 *
 * 三条进门的路，两条交路径、一条交字节，而交字节那一条只因为系统给不出路径：
 *
 *   拖放      onDragDropEvent → paths → asset_import
 *   加号      plugin-dialog 的 open() → paths → asset_import
 *   粘贴      File → base64 → asset_upload
 *
 * 前两条一个字节都不进 webview。第三条是剪贴板的物理事实：截图是一团没有
 * 名字也没有路径的 blob。
 *
 * 输入框那条资产会话是懒开的，一个进程一条：它是暂存区，一张图从被放进框里
 * 到被发出去（或被移掉）都挂在它下面。发出去之后由原生侧过继给这条对话的
 * 交付会话（asset_protocol 的 adopt，共用同一份内存），移掉就 removeAsset。
 */

/** 一次转 32 KiB。String.fromCharCode 的参数个数有上限，整张图铺开会爆栈。 */
const CHUNK = 0x8000

/** 同一批 paths 在这么久之内再来一次，当作重复触发。 */
const REPEAT_WINDOW = 1000

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''

  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }

  return btoa(binary)
}

/** 两种分隔符都要认：这个程序在 Windows 上跑，路径也可能来自别处。 */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return cut === -1 ? path : path.slice(cut + 1)
}

/** 剪贴板里的图没有名字，给它一个带时刻的。 */
function stampedName(mediaType: string): string {
  const extension = mediaType.split('/')[1] ?? 'png'
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')

  return `pasted-${stamp}.${extension}`
}

export function createAttachmentIntake(): AttachmentIntake {
  let opened: Promise<string> | undefined
  let offered: Promise<readonly AssetFormat[]> | undefined

  const composerSession = (): Promise<string> => {
    opened ??= openAssetSession()
    return opened
  }

  const knownFormats = (): Promise<readonly AssetFormat[]> => {
    offered ??= listAssetFormats()
    return offered
  }

  const intake = async (paths: readonly string[]): Promise<readonly ComposerAsset[]> => {
    if (paths.length === 0) {
      return []
    }

    const sessionToken = await composerSession()
    const stored = await importAssets(sessionToken, paths)

    return stored.map((asset, index) => ({
      sessionToken,
      assetToken: asset.assetToken,
      url: asset.source,
      filename: basename(paths[index] ?? asset.assetToken),
      mediaType: asset.contentType,
    }))
  }

  return {
    async pick(multiple) {
      /* 两件事互不依赖，串着等没有理由。第二次起清单已经在手，这里就只剩
      模块加载那一下。 */
      const [{ open }, formats] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        knownFormats(),
      ])

      const picked = await open({
        multiple,
        directory: false,
        filters: [{ name: '图片', extensions: formats.flatMap((format) => format.extensions) }],
      })

      if (picked === null) {
        return []
      }

      return intake(Array.isArray(picked) ? picked : [picked])
    },

    watchDrop(onDropped) {
      let cancelled = false
      let stop: (() => void) | null = null
      let last = ''

      void import('@tauri-apps/api/webview')
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((event) => {
            if (event.payload.type !== 'drop') {
              return
            }

            /*
             * 同一次拖放可能报两遍。
             *
             * 上游缺陷 tauri#14134：一次拖放触发两次 drop，paths 完全相同，
             * 间隔几毫秒。不去重的后果不是多一张卡片（身份是内容摘要，输入框
             * 那一侧会认出是同一张），而是白读一遍盘、白算一遍 SHA-256。
             *
             * 判据是这一批路径本身，而不是一个时间窗内的任意一次拖放：真的
             * 连着拖两批不同的文件必须两批都收。窗口过后清掉，同一批文件再
             * 拖一次仍然算数。
             */
            const signature = event.payload.paths.join('\u0000')

            if (signature === last) {
              return
            }

            last = signature

            setTimeout(() => {
              if (last === signature) {
                last = ''
              }
            }, REPEAT_WINDOW)

            void intake(event.payload.paths).then(onDropped, () => {
              /* 这一批一个都收不下（拖了个 .zip 进来）。屏幕上就是没有反应，
              与加号那条路一致 —— 不为一次没进门的拖放弹一个报错。 */
            })
          }),
        )
        .then((unlisten) => {
          if (cancelled) {
            unlisten()

            return
          }

          stop = unlisten
        })
        .catch(() => {
          /* 监听装不上，拖放就是不工作。别的路照常。 */
        })

      return () => {
        cancelled = true
        stop?.()
        stop = null
      }
    },

    async paste(file) {
      const sessionToken = await composerSession()
      const stored = await uploadAsset(sessionToken, base64Of(await file.arrayBuffer()))

      return {
        sessionToken,
        assetToken: stored.assetToken,
        url: stored.source,
        filename: file.name.length > 0 ? file.name : stampedName(stored.contentType),
        mediaType: stored.contentType,
      }
    },

    discard(asset) {
      /* 有意的 fire-and-forget：放不掉一份暂存字节不该让移除按钮卡住，
      而这条会话在进程退出时整条作废。 */
      void removeAsset(asset.sessionToken, asset.assetToken).catch(() => {})
    },
  }
}
