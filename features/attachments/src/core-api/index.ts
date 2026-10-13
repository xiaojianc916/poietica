import { defineServiceToken } from '@poietica/foundation'

export interface ResolvedAttachment {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly kind: 'image' | 'file'
  readonly path: string
}
export interface DescribedAttachment {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly kind: 'image' | 'file'
  readonly size: number
  readonly previewUrl: string | null
}
export interface AttachmentsService {
  /**
   * 把磁盘上的文件导入附件库：与输入框添加附件同一条管线 —— 50 MB 上限、扩展名定 mime、按内容去重。只建 item 行、不挂引用：调用方随后
   * 必须 retain 到自己的 ownerKey，否则 24 小时后被回收。不存在 / 不是文件 / 超限时抛 attachments.* 错误。
   */
  importPaths(paths: readonly string[]): Promise<readonly DescribedAttachment[]>
  resolve(ids: readonly string[]): readonly ResolvedAttachment[]
  /** id 不存在就抛错（与 resolve 同一条判据）。 */
  describe(ids: readonly string[]): readonly DescribedAttachment[]
  retain(ids: readonly string[], ownerKey: string): void
  releaseOwner(ownerKey: string): void
  /**
   * 分支对话继承源线程的附件引用。分支的历史里，文件类附件是以路径交给 omp 的；没有这一步，删掉原对话后 24 小时的回收会把分支还要用的
   * 文件删掉。
   */
  copyOwner(from: string, to: string): void
}
export const AttachmentsServiceToken = defineServiceToken<AttachmentsService>('attachments', 'AttachmentsService')
