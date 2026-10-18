import { defineHostModule } from '@poietica/host-kernel'
import { MEDIA_ASSET_HOST, WIDGET_ASSET_HOST } from '../contract'
import { createMediaAssetHandler } from './media-handler'
import { createWidgetShellHandler } from './widget-shell'

/**
 * conversation 的 host 模块（审查 R-18）：注册对话内组件的外壳文档，以及时间线图片（按 sha256 读 omp 的 blob 目录）。
 * conversation 的契约没有 owner='host' 的方法，所以**不声明 contract**（与 attachments 的 host 同形）。
 */
export default defineHostModule({
  id: 'conversation',
  setup(ctx) {
    ctx.assets.register(WIDGET_ASSET_HOST, createWidgetShellHandler())
    ctx.assets.register(MEDIA_ASSET_HOST, createMediaAssetHandler({ blobsDir: ctx.layout.ompBlobsDir }))
  },
})
