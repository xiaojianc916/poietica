import { defineHostModule } from '@poietica/host-kernel'
import { MEDIA_ASSET_HOST } from '../contract'
import { createMediaAssetHandler } from './media-handler'

/**
 * conversation 的 host 模块：注册时间线图片（按 sha256 读 omp 的 blob 目录）。对话内组件的外壳文档归 widgets。
 * conversation 的契约没有 owner='host' 的方法，所以**不声明 contract**（与 attachments 的 host 同形）。
 */
export default defineHostModule({
  id: 'conversation',
  setup(ctx) {
    ctx.assets.register(MEDIA_ASSET_HOST, createMediaAssetHandler({ blobsDir: ctx.layout.ompBlobsDir }))
  },
})
