/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import {
  type ComposerDraft,
  ConversationUiToken,
  composerInputHandlers,
  composerProviders,
} from '@poietica/feature-conversation/ui-api'
import { platformContract } from '@poietica/feature-platform/contract'
import { defineUiFeature, ToastsToken } from '@poietica/ui-kernel'
import type { ReactNode } from 'react'
import { createAttachmentsApi } from './api'
import { createDraftRefSync } from './draft-refs'
import { AttachmentIntakeProvider, createAttachmentIntake } from './intake-provider'
import { imageFromClipboard, importClipboardImage, pathsFromDrop } from './paste'

/* legacy 里附件的入库口由宿主持有，经 `AttachmentIntakeContext` 发给输入框；新架构里这份能力属于 attachments 功能 —— 它认识 platform 的
 * dialog.pickFiles 与自己的契约方法。两处落点：composerProviders 把入库口**注入输入框树**（输入框左端那枚回形针**不在这里**：legacy 与基准
 * 截图 #03 都只有一枚加号）；composerInputHandlers 里剪贴板的图片 → importData、拖放的本地文件 → pathForFile → importPaths，返回 true 表示
 * 事件已经被吃掉。 */
export default defineUiFeature({
  id: 'attachments',
  dependsOn: ['conversation', 'platform'],
  setup(ctx) {
    const api = createAttachmentsApi(ctx)
    const platform = ctx.rpc(platformContract)
    const toasts = ctx.services.get(ToastsToken)

    /* 依赖方向本来就是 attachments → conversation，所以这一侧持有同步逻辑，读 conversation 交出的草稿视图、调自己的契约。 */
    const draftAttachments = ctx.services.get(ConversationUiToken).draftAttachments
    const draftRefs = createDraftRefSync({
      drafts: draftAttachments,
      setOwnerRefs: (ownerKey, attachmentIds) => api.setOwnerRefs(ownerKey, attachmentIds),
      warn: (message, data) => {
        ctx.logger.warn(message, data)
      },
      reportMissing: (count) => {
        toasts.show({ severity: 'warning', title: `有 ${count} 个草稿附件已失效，已从草稿中移除` })
      },
    })
    ctx.lifecycle.onDispose(
      draftAttachments.subscribe(() => {
        draftRefs.schedule()
      }),
    )
    ctx.lifecycle.onDispose(() => {
      draftRefs.dispose()
    })
    ctx.lifecycle.onCoreReady(() => {
      draftRefs.onCoreReady()
    })

    const addPaths = async (draft: ComposerDraft, paths: readonly string[]): Promise<boolean> => {
      if (paths.length === 0) return false
      try {
        const imported = await api.importPaths(paths)
        draft.addAttachments(imported.map((a) => ({ id: a.id, name: a.name, kind: a.kind, previewUrl: a.previewUrl })))
        return true
      } catch (e) {
        toasts.error(e)
        return true
      }
    }

    const addImage = async (draft: ComposerDraft, file: File): Promise<boolean> => {
      try {
        const imported = await importClipboardImage(api, file)
        draft.addAttachments([
          { id: imported.id, name: imported.name, kind: imported.kind, previewUrl: imported.previewUrl },
        ])
        return true
      } catch (e) {
        toasts.error(e)
        return true
      }
    }

    const intake = createAttachmentIntake({
      api,
      multiple: true,
      pickFiles: async (multiple) => {
        const picked = await platform.call('dialog.pickFiles', { multiple })
        return picked.paths
      },
    })

    ctx.contribute(composerProviders, {
      id: 'attachments.intake',
      order: 10,
      component: (({ children }: { readonly children: ReactNode }) => (
        <AttachmentIntakeProvider intake={intake}>{children}</AttachmentIntakeProvider>
      )) as (props: { readonly children: ReactNode }) => ReactNode,
    })

    ctx.contribute(composerInputHandlers, {
      id: 'attachments.input',
      onPaste: async (event, draft) => {
        const clipboard = event.clipboardData
        if (clipboard === null) return false
        const file = imageFromClipboard([...clipboard.items])
        if (file === null) return false
        return addImage(draft, file)
      },
      onDrop: async (event, draft) => {
        const transfer = event.dataTransfer
        if (transfer === null) return false
        const files = [...transfer.files]
        const paths = pathsFromDrop(files, (file) => ctx.files.pathForFile(file))
        if (paths.length === 0) return false
        return addPaths(draft, paths)
      },
    })
  },
})
