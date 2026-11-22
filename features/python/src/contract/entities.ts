import { z } from 'zod'

/**
 * `outdated` 与 `absent` 分开：前者已经找到可执行的解释器，只是版本低于最低线；后者本机没有可用解释器。
 * 两者都显示「安装」，但文案不同。
 */
export const PythonStatus = z.object({
  state: z.enum(['absent', 'outdated', 'downloading', 'installing', 'ready', 'failed']),
  progress: z.number().min(0).max(1).nullable(),
  /** 探测到 / 安装好的版本；`absent`、`downloading`、`installing`、`failed` 时为 null */
  version: z.string().nullable(),
  /** 实际交给 agent 的 python.exe；没有可用解释器时为 null */
  interpreter: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type PythonStatus = z.infer<typeof PythonStatus>
