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
  readonly name: string // snake_case，全局唯一
  readonly label: string
  readonly description: string // 给模型看的英文描述
  readonly parameters: P // zod；engine-omp 负责转换为 omp 需要的 JSON Schema
  readonly approval: 'read' | 'write' | 'exec' // 决定在 ask / auto-edit 姿态下是否需要用户批准
  /**
   * 参数还在流的时候就上屏：模型写参数期间，时间线上先出一格 `inputPending` 的工具帧，入参按节流
   * 跟着长（engine-omp 的 LiveProjector.toolInput）。只给「参数本身就是要给用户看的内容」的工具开
   * （例如 intelligent_ui 的 html）：普通工具的参数流到一半没有意义，还白占时间线的带宽。缺省 false。
   */
  readonly streamInput?: boolean
  execute(params: z.output<P>, ctx: EngineToolContext): Promise<EngineToolResult>
}
