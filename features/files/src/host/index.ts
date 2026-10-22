import { defineHostModule } from '@poietica/host-kernel'
import { filesContract, WORKSPACE_FILE_ASSET_HOST } from '../contract'
import { createWorkspaceFileAssetHandler } from './asset-handler'

/**
 * files 的契约没有 owner='host' 的方法，所以这里**不声明 contract**（同 attachments）；host 模块只注册图片预览的资源协议。
 */
export default defineHostModule({
  id: 'files',
  setup(ctx) {
    ctx.assets.register(
      WORKSPACE_FILE_ASSET_HOST,
      createWorkspaceFileAssetHandler({
        locate: (workspaceId, path) => ctx.core.call(filesContract, 'files.locate', { workspaceId, path }),
        onError: (cause) => {
          ctx.logger.warn('workspace file asset failed', { error: String(cause) })
        },
      }),
    )
  },
})
