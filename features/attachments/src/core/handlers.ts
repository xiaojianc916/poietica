import type { CoreModuleContext } from '@poietica/core-kernel'
import type { attachmentsContract } from '../contract'
import type { AttachmentsApi } from './service'

type Ctx = CoreModuleContext<typeof attachmentsContract>

/** 契约方法 → 服务调用（每个 handler 一行） */
export function registerHandlers(ctx: Ctx, service: AttachmentsApi): void {
  ctx.rpc.handle('attachments.importPaths', async ({ paths }) => ({ attachments: await service.importPaths(paths) }))
  ctx.rpc.handle('attachments.importData', ({ name, mime, base64 }) => service.importData(name, mime, base64))
  ctx.rpc.handle('attachments.get', ({ attachmentId }) => service.get(attachmentId))
}
