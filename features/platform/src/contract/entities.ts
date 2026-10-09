import { z } from 'zod'

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error'])

export const AppInfo = z.object({
  version: z.string(),
  isPackaged: z.boolean(),
  dataRoot: z.string(),
  platform: z.literal('win32'),
})

export const FileFilter = z.object({
  name: z.string(),
  extensions: z.array(z.string().regex(/^[a-z0-9*]+$/i)),
})

export const UiLogEntry = z.object({
  ts: z.number().int(),
  level: LogLevel,
  scope: z.string().max(64),
  message: z.string().max(2_000),
  data: z.record(z.string(), z.unknown()).optional(),
})

/** 存储统计的确定清单：顺序与 id 由 07 页 §1D 的表固定，执行者不得增删 */
export const StorageEntryId = z.enum([
  'conversations',
  'database',
  'attachments',
  'omp-other',
  'scratch',
  'tools',
  'logs',
  'kernel-cache',
  'browser-data',
  'kernel-state',
])

export const StorageEntry = z.object({
  id: StorageEntryId,
  label: z.string(),
  bytes: z.number().int().nonnegative(),
  cleanable: z.enum(['none', 'safe', 'confirm']),
})

export const CoreDiagnostics = z.object({
  coreVersion: z.string(),
  engineVersion: z.string(),
  dataRoot: z.string(),
  ompRoot: z.string(),
  dirs: z.record(z.string(), z.string()),
  scrubbedEnvKeys: z.array(z.string()),
})

export type AppInfo = z.infer<typeof AppInfo>
export type CoreDiagnostics = z.infer<typeof CoreDiagnostics>
export type FileFilter = z.infer<typeof FileFilter>
export type StorageEntry = z.infer<typeof StorageEntry>
export type StorageEntryId = z.infer<typeof StorageEntryId>
export type UiLogEntry = z.infer<typeof UiLogEntry>
