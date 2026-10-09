/*
 * 扩展名 → MIME 的查表（07 页 §4C：“mime 由扩展名表判断，未知为 application/octet-stream”）。
 *
 * 迁移自 legacy 的附件选择逻辑：legacy 的渲染层用浏览器的 File.type 拿到 mime，而新架构里
 * 文件路径在 Core 侧（拖放路径经 ctx.files.pathForFile 传过来），没有 File 对象可问，
 * 所以这张表是必需的一格。内容嗅探不做：附件是用户自己选的文件，扩展名就是他的意思表示。
 */
const TABLE: Readonly<Record<string, string>> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  // 文档
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonc: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  // 表格与办公
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 压缩
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  // 音视频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
}

export const DEFAULT_MIME = 'application/octet-stream'

/** 从文件名（或路径）的扩展名判断 MIME；未知一律 application/octet-stream */
export function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return DEFAULT_MIME
  const ext = name.slice(dot + 1).toLowerCase()
  return TABLE[ext] ?? DEFAULT_MIME
}

/** kind 由 mime 决定（07 页 §4C）：图片走图片的展示路径，其余都是文件 */
export function kindOf(mime: string): 'image' | 'file' {
  return mime.startsWith('image/') ? 'image' : 'file'
}
