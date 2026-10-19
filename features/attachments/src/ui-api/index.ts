import { defineServiceToken } from '@poietica/foundation'
import type { Attachment } from '../contract'

/*
 * attachments 给别的 UI 功能的服务：把文件、字节、剪贴板与拖放**收进附件库**，以及替持有草稿的一方做引用登记。
 *
 * 这里只认自己的实体（`Attachment`），不认识输入框：怎样把入库结果画进草稿、草稿长什么样，是消费方（conversation）
 * 的事。依赖方向因此是 conversation → attachments，与 Core 侧（conversation/core 经 attachments 的 core-api 登记引用）
 * 同向 —— 之前 UI 侧反过来（attachments 实现 conversation 的 ui-api 里定义的入库口），两个进程方向相反，包级成环。
 */

/** 草稿引用的附件：持有草稿的一方交出这份只读视图，引用的整体替换由 attachments 调自己的契约完成（R-07 §3.4）。 */
export interface DraftRefSource {
  /**
   * 全部草稿引用的附件 id，去重、升序。
   *
   * **草稿还没从盘上恢复时为 null**：Core 就绪可能先于草稿读盘，那一刻拿空集合去整体替换会把盘上草稿的引用全部清掉。
   */
  ids(): readonly string[] | null
  /** id 集合变化时回调（打字不触发）；恢复完成时也回调一次 */
  subscribe(listener: () => void): () => void
  /** 从所有草稿里移除这些附件，返回实际移除的条数 */
  drop(ids: readonly string[]): number
}

export interface AttachmentsUi {
  /** 本地路径入库；空数组直接交回空数组。失败照常抛出，由调用方决定怎么提示。 */
  importPaths(paths: readonly string[]): Promise<readonly Attachment[]>
  /** 弹系统的选文件框再入库；用户取消就是空数组。 */
  pick(multiple: boolean): Promise<readonly Attachment[]>
  /** 字节入库（截图粘贴等没有路径的来源）；文件名为空时按「粘贴的图片」起名。 */
  importData(filename: string, mime: string, bytes: Uint8Array): Promise<Attachment>
  /**
   * 这次粘贴归不归附件库（超长纯文字收成一份 .md）。**必须同步**：要在编辑器把文字插进去之前答出来。
   */
  claimsPaste(event: ClipboardEvent): boolean
  /**
   * 剪贴板 → 附件库：超长纯文字、第一张图片。不归附件库的粘贴交回 null（调用方照常处理这个事件）；
   * 归附件库但入库失败时，这里已经报过错，交回空数组（事件算被吃掉）。
   */
  fromPaste(event: ClipboardEvent): Promise<readonly Attachment[] | null>
  /** 拖进来的本地文件 → 附件库；语义同 fromPaste。 */
  fromDrop(event: DragEvent): Promise<readonly Attachment[] | null>
  /** 开始替这份草稿视图登记引用（防抖、串行、Core 换代后重发）；返回值撤销登记。 */
  trackDraftRefs(source: DraftRefSource): () => void
}

export const AttachmentsUiToken = defineServiceToken<AttachmentsUi>('attachments', 'AttachmentsUi')
