import { z } from 'zod'

export const PythonStatus = z.object({
  state: z.enum(['absent', 'downloading', 'installing', 'ready', 'failed']),
  progress: z.number().min(0).max(1).nullable(),
  version: z.string().nullable(),
  interpreter: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type PythonStatus = z.infer<typeof PythonStatus>

export const InstallMarker = z.object({
  tag: z.string(),
  version: z.string(),
  sha256: z.string(),
  installedAt: z.number().int(),
})
export type InstallMarker = z.infer<typeof InstallMarker>
