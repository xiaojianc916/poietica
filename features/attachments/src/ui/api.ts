import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import { type Attachment, attachmentsContract } from '../contract'

/** ctx.rpc(attachmentsContract) 的薄封装 */
export function createAttachmentsApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof attachmentsContract> = ctx.rpc(attachmentsContract)
  return {
    importPaths: (paths: readonly string[]): Promise<Attachment[]> =>
      rpc
        .call('attachments.importPaths', { paths: [...paths] })
        .then((r: { attachments: Attachment[] }) => r.attachments),
    importData: (name: string, mime: string, base64: string): Promise<Attachment> =>
      rpc.call('attachments.importData', { name, mime, base64 }),
    get: (attachmentId: string): Promise<Attachment> => rpc.call('attachments.get', { attachmentId }),
  }
}

export type AttachmentsApi = ReturnType<typeof createAttachmentsApi>
