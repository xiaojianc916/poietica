import type { Attachment } from '../contract'
import type { AttachmentsApi } from './api'

/*
 * 粘进来的整份文档不该整段进编辑器：几百行文字要逐行建节点、每次按键再全量对齐 DOM，
 * 量大到一定程度会把渲染进程拖死。判据只看行数（与用户气泡、工具输出同一条），字节数不参与。
 */
export const PASTE_TEXT_ABOVE_LINES = 50

/** 这段纯文本是不是该收成文件。 */
export function claimsLongText(text: string): boolean {
  return text.length > 0 && text.split('\n').length > PASTE_TEXT_ABOVE_LINES
}

/** 剪贴板里那份纯文字；没有就交回空串。 */
export function textFromClipboard(clipboardData: DataTransfer | null): string {
  return clipboardData?.getData('text/plain') ?? ''
}

/** 收成一份 markdown：文件名与 mime 都按「这是一份粘来的文字」来写。 */
export function markdownOf(text: string): { bytes: Uint8Array; filename: string; mime: string } {
  return {
    bytes: new TextEncoder().encode(text),
    filename: '粘贴的文本.md',
    mime: 'text/markdown',
  }
}

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
