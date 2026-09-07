import { type ToolCallFrame, ViewRegistry } from '@poietica/transcript'
import type { ToolKind } from '../agent/tool-call'

interface ToolMeaning {
  readonly kind: ToolKind
  readonly subject?: string
}

// 身份先于可选展示信息；同一规则用于流式输入和冷恢复。
const tools = new ViewRegistry<ToolMeaning>()
  .registerTool('Bash', { kind: 'execute', subject: 'command' })
  .registerTool('Read', { kind: 'read', subject: 'path' })
  .registerTool('ReadMediaFile', { kind: 'read', subject: 'path' })
  .registerTool('Write', { kind: 'write', subject: 'path' })
  .registerTool('Edit', { kind: 'edit', subject: 'path' })
  .registerTool('Grep', { kind: 'search', subject: 'pattern' })
  .registerTool('Glob', { kind: 'search', subject: 'pattern' })
  .registerTool('WebSearch', { kind: 'search', subject: 'query' })
  .registerTool('FetchURL', { kind: 'fetch', subject: 'url' })
  .registerTool('Agent', { kind: 'delegate', subject: 'description' })
  .registerTool('AgentSwarm', { kind: 'delegate', subject: 'prompt_template' })
  .registerTool('Skill', { kind: 'skill', subject: 'skill' })
  .registerTool('TodoList', { kind: 'todo' })
  .registerTool('EnterPlanMode', { kind: 'plan' })
  .registerTool('ExitPlanMode', { kind: 'plan' })
  .registerTool('TaskList', { kind: 'task' })
  .registerTool('TaskOutput', { kind: 'task', subject: 'task_id' })
  .registerTool('TaskStop', { kind: 'task', subject: 'task_id' })
  .registerTool('WaitFor', { kind: 'task', subject: 'task_id' })
  .registerTool('CronCreate', { kind: 'task', subject: 'prompt' })
  .registerTool('CronList', { kind: 'task' })
  .registerTool('CronDelete', { kind: 'task', subject: 'id' })

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

export function describeKimiTool(frame: ToolCallFrame): {
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
