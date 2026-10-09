import type { EngineToolSpec } from '@poietica/engine'
import type { Logger } from '@poietica/foundation'
import { z } from 'zod'

export interface ToolBridgeOptions {
  readonly specs: ReadonlyMap<string, EngineToolSpec>
  readonly sessionKey: string
  readonly cwd: string
  readonly logger: Logger
  /** 注册一个工具：由 ExtensionFactory 提供（omp 知识 #15） */
  readonly register: (tool: Record<string, unknown>) => void
}

/**
 * 工具桥（12 页 §11.1）：把 EngineToolSpec 变成 omp 的 ToolDefinition。
 *
 * omp 知识 #15：内置工具必须用 extensions，不能用 customTools —— 后者会替换掉 omp 的默认工具。
 * loadMode 必须是 'essential'：扩展工具默认是 discoverable，模型要先搜索才能看到；产品工具必须常驻。
 */
export function createToolsExtension(o: ToolBridgeOptions): void {
  for (const spec of o.specs.values()) {
    o.register({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: z.toJSONSchema(spec.parameters),
      approval: spec.approval,
      loadMode: 'essential',
      execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) =>
        await executeTool(spec, params, signal, o),
      intent: 'omit',
    })
  }
}

/**
 * 一次工具执行。参数先校验（失败时把 zod 的说明交回模型，让它自己修正重试）；
 * 抛出的异常**绝不冒到 omp**，否则会话会进入错误状态（12 页 §11.1）。
 */
async function executeTool(
  spec: EngineToolSpec,
  params: unknown,
  signal: AbortSignal | undefined,
  o: ToolBridgeOptions,
): Promise<{ content: { type: 'text'; text: string }[]; details?: unknown; isError?: boolean }> {
  const parsed = spec.parameters.safeParse(params)
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `参数无效：${z.prettifyError(parsed.error)}` }], isError: true }
  }
  try {
    const result = await spec.execute(parsed.data as never, {
      cwd: o.cwd,
      // omp 传入的 signal 可能为 undefined，此时给一个永不触发的
      signal: signal ?? new AbortController().signal,
      sessionKey: o.sessionKey,
    })
    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.details === undefined ? {} : { details: result.details }),
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    o.logger.warn('tool execution failed', { tool: spec.name, error: message })
    return { content: [{ type: 'text', text: `工具执行失败：${message}` }], isError: true }
  }
}
