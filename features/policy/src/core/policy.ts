import type {
  PolicyAction,
  PolicyContext,
  PolicyDecision,
  PolicyPreset,
  ToolClassification,
} from '../contract/entities'

const CATEGORIES = new Map<string, ToolClassification>([
  ...['bash', 'shell'].map(
    (name) => [name, { category: 'exec' as const, risk: 'high' as const, checkpoint: true }] as const,
  ),
  ...['eval', 'python'].map(
    (name) => [name, { category: 'code.eval' as const, risk: 'high' as const, checkpoint: true }] as const,
  ),
  ...['edit', 'apply_patch', 'ast_edit', 'write', 'notebook'].map(
    (name) => [name, { category: 'file.write' as const, risk: 'medium' as const, checkpoint: true }] as const,
  ),
  ...['read', 'grep', 'glob', 'find'].map(
    (name) => [name, { category: 'file.read' as const, risk: 'low' as const, checkpoint: false }] as const,
  ),
  ...['fetch', 'search', 'browser', 'web_search', 'generate_image'].map(
    (name) => [name, { category: 'network' as const, risk: 'medium' as const, checkpoint: false }] as const,
  ),
  ['task', { category: 'agent', risk: 'high', checkpoint: false }],
  ...[
    'todo',
    'plan',
    'ask',
    'retain',
    'recall',
    'reflect',
    'learn',
    'manage_skill',
    'wait',
    'goal',
    'think',
    'yield',
    'context_notes',
    'new_context',
    'tts',
  ].map((name) => [name, { category: 'meta' as const, risk: 'low' as const, checkpoint: false }] as const),
  ...['checkpoint', 'rewind'].map(
    (name) => [name, { category: 'file.write' as const, risk: 'medium' as const, checkpoint: true }] as const,
  ),
  ...['computer', 'debug', 'ida', 'github'].map(
    (name) => [name, { category: 'exec' as const, risk: 'high' as const, checkpoint: true }] as const,
  ),
  ...['security_scan', 'lsp'].map(
    (name) => [name, { category: 'file.read' as const, risk: 'low' as const, checkpoint: false }] as const,
  ),
])

const DANGEROUS: readonly { readonly pattern: RegExp; readonly action: PolicyAction; readonly rule: string }[] = [
  { pattern: /\b(format|diskpart|bcdedit)\b/i, action: 'deny', rule: 'command.system_destructive' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brmdir\s+\/s|\bdel\s+\/[fsq]/i, action: 'ask', rule: 'command.recursive_delete' },
  { pattern: /\bgit\s+push\s+.*--force|\bgit\s+reset\s+--hard\b/i, action: 'ask', rule: 'command.git_destructive' },
  { pattern: /\breg\s+delete\b|\bshutdown\b|\breboot\b/i, action: 'deny', rule: 'command.system_mutation' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|power(?:shell)?)/i, action: 'deny', rule: 'command.remote_pipe' },
]

const SAFE_COMMAND =
  /^\s*(ls|dir|pwd|cd|git\s+(status|diff|log|show|branch|rev-parse)|rg|grep|cat|type|Get-Content|Get-ChildItem|where|which)\b/i

/** 未知工具按高风险处理：omp 新增工具不能绕过策略。 */
export function classifyTool(name: string): ToolClassification {
  const bare = name.replace(/^mcp__.*/, 'mcp').replace(/^plugin__.*/, 'plugin')
  const held = CATEGORIES.get(bare)
  if (held !== undefined) return held
  if (bare.startsWith('mcp')) return { category: 'mcp', risk: 'high', checkpoint: true }
  if (bare.startsWith('plugin')) return { category: 'plugin', risk: 'high', checkpoint: true }
  return { category: 'unknown', risk: 'high', checkpoint: true }
}

export function evaluatePolicy(preset: PolicyPreset, toolName: string, context: PolicyContext = {}): PolicyDecision {
  return evaluateClassification(preset, classifyTool(toolName), context)
}

/** 已知道分类时（产品工具按 spec.approval 映射）直接裁决，不再按名字查表。 */
export function evaluateClassification(
  preset: PolicyPreset,
  classification: ToolClassification,
  context: PolicyContext = {},
): PolicyDecision {
  const decision = (action: PolicyAction, rule: string, reason: string): PolicyDecision => ({
    action,
    rule,
    reason,
    preset,
    classification,
  })
  if (classification.category === 'meta') return decision('allow', 'meta.always', '元数据工具不改磁盘')
  if (classification.category === 'file.read') return decision('allow', 'file.read', '只读文件访问')
  if (classification.category === 'exec' || classification.category === 'code.eval') {
    return execDecision(preset, context, decision)
  }
  if (classification.category === 'file.write') return writeDecision(preset, context, decision)
  if (classification.category === 'network') return networkDecision(preset, decision)
  if (classification.category === 'agent') return agentDecision(preset, decision)
  return otherDecision(preset, decision)
}

function execDecision(
  preset: PolicyPreset,
  context: PolicyContext,
  decision: (action: PolicyAction, rule: string, reason: string) => PolicyDecision,
): PolicyDecision {
  const command = context.command ?? ''
  const dangerous = DANGEROUS.find((entry) => entry.pattern.test(command))
  if (dangerous !== undefined && (dangerous.action === 'deny' || preset !== 'full-access')) {
    return decision(dangerous.action, dangerous.rule, '命中危险命令规则')
  }
  if (preset === 'full-access') return decision('allow', 'preset.full_access', '完全访问只拦系统级破坏')
  if (preset === 'read-only') return decision('ask', 'preset.read_only.exec', '只读预设下执行命令要询问')
  if (SAFE_COMMAND.test(command)) return decision('allow', 'command.safe', '只读命令')
  return decision('ask', 'command.unknown', '命令不在安全表内')
}

function writeDecision(
  preset: PolicyPreset,
  context: PolicyContext,
  decision: (action: PolicyAction, rule: string, reason: string) => PolicyDecision,
): PolicyDecision {
  if (preset === 'read-only') return decision('deny', 'preset.read_only.write', '只读预设禁止写文件')
  if (preset === 'full-access') return decision('allow', 'preset.full_access', '完全访问')
  if (preset === 'ask') return decision('ask', 'preset.ask.write', '询问预设下写入要确认')
  const outside = (context.paths ?? []).some(
    (path) => context.workspaceRoot !== undefined && !path.startsWith(context.workspaceRoot),
  )
  if (outside) return decision('ask', 'file.write.outside_workspace', '目标在工作区之外')
  return decision('allow', 'file.write.workspace', '工作树内写入')
}

function networkDecision(
  preset: PolicyPreset,
  decision: (action: PolicyAction, rule: string, reason: string) => PolicyDecision,
): PolicyDecision {
  if (preset === 'read-only') return decision('deny', 'preset.read_only.network', '只读预设关闭网络')
  if (preset === 'auto-edit' || preset === 'ask') return decision('ask', 'preset.network_ask', '网络访问要确认')
  return decision('allow', 'preset.full_access', '完全访问')
}

function agentDecision(
  preset: PolicyPreset,
  decision: (action: PolicyAction, rule: string, reason: string) => PolicyDecision,
): PolicyDecision {
  return preset === 'read-only'
    ? decision('ask', 'preset.read_only.agent', '只读预设下子代理要确认')
    : decision('allow', 'agent.delegated', '子代理按它实际调用的工具裁决')
}

function otherDecision(
  preset: PolicyPreset,
  decision: (action: PolicyAction, rule: string, reason: string) => PolicyDecision,
): PolicyDecision {
  return preset === 'full-access'
    ? decision('allow', 'preset.full_access', '完全访问')
    : decision('ask', 'tool.unknown_high_risk', '未知或第三方工具按高风险询问')
}
