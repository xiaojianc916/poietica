import type { Attachment } from '../contract'
import type { AttachmentsApi } from './api'

/* 两件事分开写：取数（浏览器给的 File / DataTransfer）与入库（契约方法），这样两条路都能单测。 */
/** 粘贴事件里的第一张图片；没有图就交回 null（调用方据此决定要不要吃掉这个事件） */
export function imageFromClipboard(items: readonly DataTransferItem[]): File | null {
  for (const item of items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file?.type.startsWith('image/')) return file
  }
  return null
}

export async function fileToBase64(file: File): Promise<string> {
  return new Uint8Array(await file.arrayBuffer()).toBase64()
}

export async function importClipboardImage(api: AttachmentsApi, file: File): Promise<Attachment> {
  const base64 = await fileToBase64(file)
  const name = file.name === '' ? '粘贴的图片.png' : file.name
  return api.importData(name, file.type === '' ? 'image/png' : file.type, base64)
}

/**
 * 拖放进来的文件 → 本地路径。渲染进程拿不到 File.path（Electron 32 起移除），所以要经 preload 暴露的 webUtils.getPathForFile。
 */
export function pathsFromDrop(files: readonly File[], pathForFile: (file: File) => string): string[] {
  const out: string[] = []
  for (const file of files) {
    try {
      const path = pathForFile(file)
      if (path !== '') out.push(path)
    } catch {}
  }
  return out
}
