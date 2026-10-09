import { defineHostModule } from '@poietica/host-kernel'
import { createAttachmentAssetHandler } from './asset-handler'

/**
 * attachments 的契约没有 owner='host' 的方法，所以这里**不声明 contract**（07 页 §4D 末句）；
 * host 模块只注册预览协议处理器。
 */
export default defineHostModule({
  id: 'attachments',
  setup(ctx) {
    ctx.assets.register('attachment', createAttachmentAssetHandler({ attachmentsDir: ctx.layout.attachmentsDir }))
  },
})
