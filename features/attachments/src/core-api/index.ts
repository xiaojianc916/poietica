import { defineServiceToken } from '@poietica/foundation'

export interface ResolvedAttachment {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly kind: 'image' | 'file'
  readonly path: string
}
/** 只查表的附件描述（不碰盘）：提交回显要的就是它。 */
export interface DescribedAttachment {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly kind: 'image' | 'file'
  readonly size: number
  readonly previewUrl: string | null
}
export interface AttachmentsService {
  resolve(ids: readonly string[]): readonly ResolvedAttachment[]
  /** 查表取提交回显要的那几格；id 不存在就抛错（与 resolve 同一条判据）。 */
  describe(ids: readonly string[]): readonly DescribedAttachment[]
  /** ownerKey 约定：'<功能 id>:<实体>:<id>'，例如 'conversation:thread:01J…' */
  retain(ids: readonly string[], ownerKey: string): void
  releaseOwner(ownerKey: string): void
  /**
   * 分支对话继承源线程的附件引用（R-07 §3.3）。
   *
   * 分支的历史里，文件类附件是以路径交给 omp 的；没有这一步，删掉原对话后
   * 24 小时的回收会把分支还要用的文件删掉。
   */
  copyOwner(from: string, to: string): void
}
export const AttachmentsServiceToken = defineServiceToken<AttachmentsService>('attachments', 'AttachmentsService')
