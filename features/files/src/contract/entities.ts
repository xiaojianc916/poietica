import { z } from 'zod'

/*
 * 工作区文件的只读视图。路径一律是**相对工作区根**的正斜杠路径（'' 是根本身）：界面拿它当身份、拼树、显示；
 * 绝对路径只在 files.locate 里交出去（Host 的图片资源协议按它读字节），不在别处流转。
 */

export const FileEntryKind = z.enum(['file', 'directory'])
export type FileEntryKind = z.infer<typeof FileEntryKind>

export const FileEntry = z.object({
  name: z.string(),
  /** 相对工作区根。 */
  path: z.string(),
  kind: FileEntryKind,
  /** 被 .gitignore 忽略（不是仓库时恒为 false）：树里淡一档，仍然列出 —— 人常常就是要看 dist/ 里那一份。 */
  ignored: z.boolean(),
})
export type FileEntry = z.infer<typeof FileEntry>

export const DirectoryListing = z.object({
  path: z.string(),
  entries: z.array(FileEntry),
  /** 条目超过上限被截掉：界面在末尾说一句「还有没列出的」，而不是假装列全了。 */
  truncated: z.boolean(),
})
export type DirectoryListing = z.infer<typeof DirectoryListing>

const Stamp = {
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
}

export const TextEncoding = z.enum(['utf-8', 'utf-16le', 'utf-16be', 'lossy'])
export type TextEncoding = z.infer<typeof TextEncoding>

/** 一个文件读出来是什么：正文（可能截断）、图片（字节走资源协议，不进 RPC）、或认不出的二进制。 */
export const FileContent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    ...Stamp,
    text: z.string(),
    encoding: TextEncoding,
    /** 只读了开头一段（见 core 的 TEXT_LIMIT）：界面要明说，不能让人以为文件就这么长。 */
    truncated: z.boolean(),
  }),
  z.object({ kind: z.literal('image'), ...Stamp, mime: z.string() }),
  z.object({ kind: z.literal('binary'), ...Stamp }),
])
export type FileContent = z.infer<typeof FileContent>

export const LocatedFile = z.object({
  /** 相对工作区根。 */
  path: z.string(),
  absolutePath: z.string(),
  kind: FileEntryKind,
})
export type LocatedFile = z.infer<typeof LocatedFile>

export const FileSearchHit = z.object({ path: z.string() })
export type FileSearchHit = z.infer<typeof FileSearchHit>
