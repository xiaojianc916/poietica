import type { AttachmentId } from './ids'

/**
 * 附件的字节在哪：只有一种 —— 按原始字节的 sha256 内容寻址的媒体（omp 的 blob 目录，`DataLayout.ompBlobsDir`）。
 *
 * 时间线里**不内联像素**（data URL / base64）：时间线要走 Core→Host 的 stdio、主进程的 JSON.parse 与结构化克隆、
 * 渲染进程的 store、增量补发缓存与开着那一轮的快照 —— 一张 5 MB 的图在每一跳各复制一次，大帧还会卡住主线程。
 * 界面按 sha 拼资源协议地址（conversation 契约的 `mediaAssetUrl`），字节由 Host 从磁盘直接流给 <img>。
 */
export interface AttachmentSource {
  readonly kind: 'blob'
  readonly sha256: string
}

export interface TranscriptAttachment {
  readonly attachmentId: AttachmentId
  readonly mediaType: string
  readonly name?: string
  readonly size?: number
  readonly source?: AttachmentSource
  readonly placeholder?: string
}
