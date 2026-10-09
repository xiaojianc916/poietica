import { z } from 'zod'

/**
 * 应用自动更新的状态（07 页 §15B）。
 *
 * 七个相位里，`disabled` 是**更新器缺席**时的固定值（开发版与安装版都由 Host 装配
 * electron-updater —— 开发版读 dev-app-update.yml，见 host/index.ts）；
 * `error` 只带一句给用户看的中文，原始异常进日志（守则 7：日志走 ctx.logger）。
 */
export const UpdateState = z.object({
  phase: z.enum(['disabled', 'idle', 'checking', 'available', 'downloading', 'ready', 'error']),
  currentVersion: z.string(),
  /** 发现的新版本号（available / downloading / ready） */
  version: z.string().nullable(),
  /** 发布说明（纯文本；HTML 已由 notesToText 去标签） */
  notes: z.string().nullable(),
  /** downloading 时的进度，0–1 */
  progress: z.number().min(0).max(1).nullable(),
  /** error 时的中文文案 */
  error: z.string().nullable(),
  lastCheckedAt: z.number().int().nullable(),
})
export type UpdateState = z.infer<typeof UpdateState>
