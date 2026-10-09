import type { EngineToolSpec } from '@poietica/engine'

/**
 * 工具展示词汇（12 页 §9.4）：工具名 → 中文标题。
 *
 * 只迁移**依赖 omp 事件形状**的部分：omp 的工具名是稳定的线上标识符，而渲染组件属于 UI，
 * 留在 conversation/ui（07 页）。legacy 的 omp-tool-view.ts 里那些读 legacy 帧形状的代码不在这里。
 */
const BUILTIN_TITLES: Readonly<Record<string, string>> = Object.freeze({
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  bash: '执行命令',
  glob: '查找文件',
  grep: '搜索内容',
  task: '子任务',
  todo: '待办',
  goal: '目标',
  ask: '提问',
  resolve: '确认',
  yield: '交付',
  eval: '求值',
  jfind: '查找',
  web_search: '联网搜索',
})

/** 工具名 → 中文标题；认不出的工具原样返回名字（不猜、不编） */
export function toolTitleOf(name: string, custom?: ReadonlyMap<string, EngineToolSpec>): string {
  const spec = custom?.get(name)
  if (spec !== undefined) return spec.label
  return BUILTIN_TITLES[name] ?? name
}

/**
 * 参数摘要：一行短的，给时间线的工具行用。
 * 逐工具取它真正的主语（读文件取路径、执行命令取命令），不 dump 整个参数对象。
 */
export function toolSummaryOf(name: string, input: unknown): string {
  const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : null
  if (args === null) return ''
  const pick = (...keys: readonly string[]): string => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value !== '') return value
    }
    return ''
  }
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return pick('path', 'file_path', 'filePath')
    case 'bash':
      return pick('command', 'cmd')
    case 'glob':
    case 'grep':
    case 'jfind':
      return pick('pattern', 'query')
    case 'web_search':
      return pick('query')
    case 'task':
      return pick('description', 'prompt')
    default:
      return pick('path', 'query', 'name', 'description', 'command')
  }
}

/** 结果的文本（与 projector 的取法同源：omp 的 { content, details } 形状） */
export function toolResultTextOf(output: unknown): string {
  const content = (output as { readonly content?: unknown } | null)?.content ?? output
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as readonly { readonly type?: unknown; readonly text?: unknown }[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}
