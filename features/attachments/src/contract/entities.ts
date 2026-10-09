import { z } from 'zod'

export const AttachmentId = z.string().min(1)

export const Attachment = z.object({
  id: AttachmentId, // ULID：每次导入一个新 id（同一内容可以有不同文件名）
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(['image', 'file']),
  createdAt: z.number().int(),
  previewUrl: z.string().nullable(), // image：poietica-asset://attachment/<sha256>?mime=<mime>；file：null
})
export type Attachment = z.infer<typeof Attachment>

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
