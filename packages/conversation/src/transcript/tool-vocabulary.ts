import { type ToolCallFrame, ViewRegistry } from '@poietica/transcript'
import type { ToolKind } from '../agent/tool-call'

interface ToolMeaning {
  readonly kind: ToolKind
  readonly subject?: string
}

/*
 * 工具名 → 它到底在做什么。
 *
 * 名字是 **agent 报上来的那一个**（oh-my-pi 的 tools/*.ts 里 `readonly name`），
 * 不是我们起的：认不出名字的会退到兜底那一档，工具卡片就只剩一个裸名字。
 * 表按名字查（ViewRegistry 两侧都折成小写），所以大小写不敏感。
 *
 * 加一家 agent 时这张表要么跟上，要么那些工具全部落进 other —— 名字是外部事实。
 */
const tools = new ViewRegistry<ToolMeaning>()
  .registerTool('bash', { kind: 'execute', subject: 'command' })
  .registerTool('read', { kind: 'read', subject: 'path' })
  .registerTool('write', { kind: 'write', subject: 'path' })
  .registerTool('edit', { kind: 'edit', subject: 'path' })
  .registerTool('ast_edit', { kind: 'edit', subject: 'path' })
  .registerTool('grep', { kind: 'search', subject: 'pattern' })
  .registerTool('ast_grep', { kind: 'search', subject: 'pattern' })
  .registerTool('glob', { kind: 'search', subject: 'path' })
  .registerTool('find', { kind: 'search', subject: 'path' })
  .registerTool('todo', { kind: 'todo' })
  .registerTool('task', { kind: 'delegate', subject: 'description' })
  .registerTool('ask', { kind: 'other', subject: 'question' })
  .registerTool('eval', { kind: 'execute', subject: 'code' })
  .registerTool('think', { kind: 'other' })
  .registerTool('learn', { kind: 'skill' })
  .registerTool('manage_skill', { kind: 'skill', subject: 'name' })
  .registerTool('hub', { kind: 'other' })
  .registerTool('debug', { kind: 'other' })
  .registerTool('rewind', { kind: 'other' })
  .registerTool('checkpoint', { kind: 'other' })
  .registerTool('context_notes', { kind: 'other' })
  .registerTool('new_context', { kind: 'other' })
  .registerTool('security_scan', { kind: 'other' })
  .registerTool('github', { kind: 'fetch', subject: 'url' })
  .registerTool('memory_edit', { kind: 'other' })
  .registerTool('recall', { kind: 'search', subject: 'query' })
  .registerTool('reflect', { kind: 'other' })
  .registerTool('retain', { kind: 'other' })
  .registerTool('yield', { kind: 'other' })
  .registerTool('web_search', { kind: 'search', subject: 'query' })
  .registerTool('lsp', { kind: 'read', subject: 'path' })
  .registerTool('wait', { kind: 'other' })
  .registerTool('browser', { kind: 'fetch' })
  .registerTool('computer', { kind: 'execute' })

const displays: Readonly<Record<string, ToolMeaning>> = {
  command: { kind: 'execute', subject: 'command' },
  file_io: { kind: 'other', subject: 'path' },
  diff: { kind: 'edit', subject: 'path' },
  search: { kind: 'search', subject: 'query' },
  url_fetch: { kind: 'fetch', subject: 'url' },
  agent_call: { kind: 'delegate', subject: 'prompt' },
  skill_call: { kind: 'skill', subject: 'skill_name' },
  todo_list: { kind: 'todo' },
  task: { kind: 'task', subject: 'description' },
  task_stop: { kind: 'task', subject: 'task_description' },
  plan_review: { kind: 'plan', subject: 'plan' },
  goal_start: { kind: 'goal', subject: 'objective' },
  generic: { kind: 'other', subject: 'summary' },
}

const fileKinds: Readonly<Record<string, ToolKind>> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  glob: 'search',
  grep: 'search',
}

function field(value: unknown, key: string | undefined): string | undefined {
  if (key === undefined || value === null || typeof value !== 'object') {
    return undefined
  }
  const result = Reflect.get(value, key)
  return typeof result === 'string' ? result : undefined
}

export function describeTool(frame: ToolCallFrame): {
  readonly kind: ToolKind
  readonly subject: string
} {
  const tool = tools.resolveTool(frame)
  const displayKind = field(frame.display, 'kind')
  const display = displays[displayKind ?? '']
  const displayToolKind =
    displayKind === 'file_io'
      ? (fileKinds[field(frame.display, 'operation') ?? ''] ?? 'other')
      : (display?.kind ?? 'other')
  return {
    kind: tool?.kind ?? displayToolKind,
    subject: field(frame.input, tool?.subject) ?? field(frame.display, display?.subject) ?? '',
  }
}
