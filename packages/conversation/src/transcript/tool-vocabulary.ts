import type { ToolKind } from '../agent/tool-call'

// 认不出的工具（MCP/插件/新增）按入参字段名猜类别与主语；顺序即优先级。
// 认得名字的工具由 omp-tool-view 的 HANDLERS 自己给。

interface Guess {
  readonly kind: ToolKind
  readonly subject: string
}

const GUESSES: readonly Guess[] = [
  { kind: 'execute', subject: 'command' },
  { kind: 'execute', subject: 'cmd' },
  { kind: 'execute', subject: 'code' },
  { kind: 'execute', subject: 'script' },
  { kind: 'search', subject: 'pattern' },
  { kind: 'search', subject: 'query' },
  { kind: 'read', subject: 'file_path' },
  { kind: 'read', subject: 'path' },
  { kind: 'write', subject: 'file_path' },
  { kind: 'write', subject: 'path' },
  { kind: 'fetch', subject: 'url' },
]

function said(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }

  const found = Reflect.get(value, key)

  return typeof found === 'string' && found !== '' ? found : undefined
}

export function describeTool(input: unknown): {
  readonly kind: ToolKind
  readonly subject: string
} {
  for (const guess of GUESSES) {
    const found = said(input, guess.subject)

    if (found !== undefined) {
      return { kind: guess.kind, subject: found }
    }
  }

  return { kind: 'other', subject: '' }
}
