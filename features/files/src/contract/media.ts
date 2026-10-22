/*
 * 哪些文件当图片预览。Core（files.read 分类）与 Host（资源协议发字节）各问一遍，所以住在契约这一层：两边说法必须一样，
 * 否则会出现「Core 说是图片、Host 拒发」的空白图。只列 Chromium 的 <img> 画得出来的类型（tiff、heic 不在内）。
 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

export function imageMimeOf(name: string): string | null {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? null : (IMAGE_MIME[base.slice(dot + 1).toLowerCase()] ?? null)
}

/** 图片的资源地址：段逐个编码（文件名里的空格、#、中文都安全），?v= 带修改时间，文件一变地址就变。 */
export function workspaceFileUrl(workspaceId: string, path: string, mtimeMs: number): string {
  const segments = [workspaceId, ...path.split('/')].map((segment) => encodeURIComponent(segment))
  return `poietica-asset://workspace-file/${segments.join('/')}?v=${String(Math.trunc(mtimeMs))}`
}
