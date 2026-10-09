import type { Attachment } from '../contract'
import type { AttachmentsApi } from './api'

/*
 * 粘贴与拖放的取数与入库：把「一段剪贴板 / 一串路径」变成草稿里的附件。
 *
 * 两件事分开写：取数（浏览器给的 File / DataTransfer）与入库（契约方法）。
 * 这样「剪贴板里的图 → importData」「拖进来的文件 → importPaths」这两条路都能单测。
 */

/** 粘贴事件里的第一张图片；没有图就交回 null（调用方据此决定要不要吃掉这个事件） */
export function imageFromClipboard(items: readonly DataTransferItem[]): File | null {
  for (const item of items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file?.type.startsWith('image/')) return file
  }
  return null
}

/** File → base64（不带 data URL 前缀，契约收的是裸 base64） */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 粘贴的图片入库 */
export async function importClipboardImage(api: AttachmentsApi, file: File): Promise<Attachment> {
  const base64 = await fileToBase64(file)
  const name = file.name === '' ? '粘贴的图片.png' : file.name
  return api.importData(name, file.type === '' ? 'image/png' : file.type, base64)
}

/**
 * 拖放进来的文件 → 本地路径。渲染进程拿不到 File.path（Electron 32 起移除），
 * 所以要经 preload 暴露的 webUtils.getPathForFile（07 页 §4C 坑 8）。
 */
export function pathsFromDrop(files: readonly File[], pathForFile: (file: File) => string): string[] {
  const out: string[] = []
  for (const file of files) {
    try {
      const path = pathForFile(file)
      if (path !== '') out.push(path)
    } catch {
      // 拿不到路径的文件（例如从浏览器拖来的图片）跳过：它不是本地文件
    }
  }
  return out
}
