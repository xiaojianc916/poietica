/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { platformContract } from '@poietica/feature-platform/contract'
import { defineUiFeature, ToastsToken } from '@poietica/ui-kernel'
import type { Attachment } from '../contract'
import { AttachmentsUiToken } from '../ui-api'
import { createAttachmentsApi } from './api'
import { createDraftRefSync, type DraftRefSync } from './draft-refs'
import {
  claimsLongText,
  imageFromClipboard,
  importClipboardImage,
  markdownOf,
  pathsFromDrop,
  textFromClipboard,
} from './paste'

/* 附件的入库口：认识 platform 的 dialog.pickFiles 与自己的契约方法，经 AttachmentsUiToken 交出去。
 * 输入框怎么用它（注入输入框树、接粘贴与拖放、交出草稿视图）是 conversation 的事 —— 这里不认识输入框。
 * 剪贴板的图片 → importData、拖放的本地文件 → pathForFile → importPaths；超长纯文字收成一份 .md。 */
export default defineUiFeature({
  id: 'attachments',
  dependsOn: ['platform'],
  setup(ctx) {
    const api = createAttachmentsApi(ctx)
    const platform = ctx.rpc(platformContract)
    const toasts = ctx.services.get(ToastsToken)

    /* 正在登记的草稿视图。Core 换代时每一份都要无条件重发（上一代 Core 收到的引用不算数）。 */
    const tracked = new Set<DraftRefSync>()
    ctx.lifecycle.onCoreReady(() => {
      for (const sync of tracked) sync.onCoreReady()
    })
    ctx.lifecycle.onDispose(() => {
      for (const sync of tracked) sync.dispose()
      tracked.clear()
    })

    /* 归附件库的事件：入库失败报一条 toast，事件仍算被吃掉（交回空数组，草稿里不多出东西）。 */
    const settle = async (run: () => Promise<readonly Attachment[]>): Promise<readonly Attachment[]> => {
      try {
        return await run()
      } catch (e) {
        toasts.error(e)
        return []
      }
    }

    const importPaths = async (paths: readonly string[]): Promise<readonly Attachment[]> =>
      paths.length === 0 ? [] : api.importPaths(paths)

    ctx.services.provide(AttachmentsUiToken, {
      importPaths,
      pick: async (multiple) => {
        const picked = await platform.call('dialog.pickFiles', { multiple })
        return importPaths(picked.paths)
      },
      importData: (filename, mime, bytes) =>
        api.importData(filename.length > 0 ? filename : '粘贴的图片.png', mime, bytes.toBase64()),
      claimsPaste: (event) => claimsLongText(textFromClipboard(event.clipboardData)),
      fromPaste: async (event) => {
        const clipboard = event.clipboardData
        if (clipboard === null) return null
        const text = textFromClipboard(clipboard)
        if (claimsLongText(text)) {
          const { bytes, filename, mime } = markdownOf(text)
          return settle(async () => [await api.importData(filename, mime, bytes.toBase64())])
        }
        const file = imageFromClipboard([...clipboard.items])
        if (file === null) return null
        return settle(async () => [await importClipboardImage(api, file)])
      },
      fromDrop: async (event) => {
        const transfer = event.dataTransfer
        if (transfer === null) return null
        const paths = pathsFromDrop([...transfer.files], (file) => ctx.files.pathForFile(file))
        if (paths.length === 0) return null
        return settle(() => api.importPaths(paths))
      },
      trackDraftRefs: (source) => {
        const sync = createDraftRefSync({
          drafts: source,
          setOwnerRefs: (ownerKey, attachmentIds) => api.setOwnerRefs(ownerKey, attachmentIds),
          warn: (message, data) => {
            ctx.logger.warn(message, data)
          },
          reportMissing: (count) => {
            toasts.show({ severity: 'warning', title: `有 ${count} 个草稿附件已失效，已从草稿中移除` })
          },
        })
        const unsubscribe = source.subscribe(() => {
          sync.schedule()
        })
        tracked.add(sync)
        return () => {
          unsubscribe()
          sync.dispose()
          tracked.delete(sync)
        }
      },
    })
  },
})
