import type { z } from 'zod'

export interface EngineToolContext {
  readonly cwd: string
  readonly signal: AbortSignal
  readonly sessionKey: string
}
export interface EngineToolResult {
  readonly text: string
  readonly details?: unknown
  readonly isError?: boolean
}

export interface EngineToolSpec<P extends z.ZodType = z.ZodType> {
  readonly name: string // snake_case，全局唯一，例如 automation_create
  readonly label: string // 中文展示名，例如“创建定时任务”
  readonly description: string // 给模型看的英文描述
  readonly parameters: P // zod；engine-omp 负责转换为 omp 需要的 JSON Schema
  readonly approval: 'read' | 'write' | 'exec' // 决定在 ask / auto-edit 姿态下是否需要用户批准
  execute(params: z.output<P>, ctx: EngineToolContext): Promise<EngineToolResult>
}
