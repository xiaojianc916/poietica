import {
  ArchiveFileIcon,
  asIcon,
  CodeFileIcon,
  DataFileIcon,
  FileIcon,
  type Icon,
  ImageFileIcon,
  ScriptFileIcon,
  TextFileIcon,
} from './icons'

/*
 * 扩展名到字形：表归本仓，字形归图标库 —— 与 icons.ts 同一条边界。
 *
 * opencode 走的是另一头：整套 material 图标收进仓库，再由 vite-plugin-icons-spritesheet
 * 生成雪碧图（packages/ui/vite.config.ts），映射表同样是它自己手维护的。这里只借那张表的
 * 范式，不开第二个图标来源。
 *
 * 字形要存进表里，所以过一遍 asIcon：图标库的 props 类型被当成值交出去之后与
 * exactOptionalPropertyTypes 对不上，理由写在 icons.ts。
 */

const ARCHIVE = asIcon(ArchiveFileIcon)
const CODE = asIcon(CodeFileIcon)
const DATA = asIcon(DataFileIcon)
const IMAGE = asIcon(ImageFileIcon)
const PLAIN = asIcon(FileIcon)
const SCRIPT = asIcon(ScriptFileIcon)
const TEXT = asIcon(TextFileIcon)

const GLYPH: Readonly<Record<string, Icon>> = {
  bash: SCRIPT,
  c: CODE,
  cjs: CODE,
  cpp: CODE,
  css: CODE,
  gif: IMAGE,
  go: CODE,
  gz: ARCHIVE,
  h: CODE,
  html: CODE,
  ico: IMAGE,
  java: CODE,
  jpeg: IMAGE,
  jpg: IMAGE,
  js: CODE,
  json: DATA,
  jsx: CODE,
  kt: CODE,
  log: TEXT,
  md: TEXT,
  mdx: TEXT,
  mjs: CODE,
  php: CODE,
  png: IMAGE,
  ps1: SCRIPT,
  py: CODE,
  rar: ARCHIVE,
  rb: CODE,
  rs: CODE,
  scss: CODE,
  sh: SCRIPT,
  sql: DATA,
  svg: IMAGE,
  swift: CODE,
  tar: ARCHIVE,
  toml: DATA,
  ts: CODE,
  tsx: CODE,
  txt: TEXT,
  webp: IMAGE,
  xml: DATA,
  yaml: DATA,
  yml: DATA,
  zip: ARCHIVE,
}

/** 一个文件名配哪一枚字形；扩展名认不出来就是一张白纸。 */
export function fileGlyphOf(name: string): Icon {
  const cut = name.lastIndexOf('.')
  const ext = cut < 0 ? '' : name.slice(cut + 1).toLowerCase()

  return GLYPH[ext] ?? PLAIN
}
