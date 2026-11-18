import path from 'node:path'
import type {
  NetworkVerdict,
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
  {
    /* 只有处在命令段首的 `format` 才是格式化磁盘：PowerShell 的 `Format-Table`、`docker --format`、
       `git log --format=%h` 都是普通参数，按词边界匹配会把它们当成系统级破坏直接拒绝。 */
    pattern:
      /(?:^|[;&|\n]\s*)\s*(?:cmd(?:\.exe)?\s+\/c\s+|powershell(?:\.exe)?\s+-command\s+|pwsh\s+-command\s+)?["']?(?:format(?:\.com)?|diskpart|bcdedit)(?=\s|$)/im,
    action: 'deny',
    rule: 'command.system_destructive',
  },
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
  if (classification.category === 'network') return networkDecision(preset, context, decision)
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
  const paths = context.paths ?? []
  /* 没有显式路径（产品工具只报了「这是写」）：自动档也不能盲放，先问。 */
  if (paths.length === 0) return decision('ask', 'file.write.unknown_scope', '这次写入没有可判定的目标路径')
  const root = context.workspaceRoot
  if (root === undefined) return decision('ask', 'file.write.outside_workspace', '没有工作区根，无法确认写入范围')
  const outside = paths.some((entry) => {
    const relative = path.relative(path.resolve(root), path.resolve(root, entry))
    return relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))
  })
  if (outside) return decision('ask', 'file.write.outside_workspace', '目标在工作区之外')
  return decision('allow', 'file.write.workspace', '工作树内写入')
}

/*
 * 网络出口规则（§13.1 的「关闭 / 白名单 / 全部开放」）。判定顺序是「预设先关门 → 目标能解析才谈得上规则 →
 * 白名单先于预设放行」：只读档没有网络，白名单对它也不开口子；其余档位里，命中白名单的立刻放行，
 * 命不中才回落到该档位的默认行为。真强制（经本地代理执行）还没做，所以这里只裁决、不拦截流量。
 *
 * 规则码是稳定契约：审批卡片与审计都按它分类，不要为了文案改它。
 */
const NETWORK_HOSTS: Readonly<Record<PolicyPreset, readonly string[]>> = {
  /* 只读档的网络是关的，白名单不存在（列在这里只为了类型齐全） */
  'read-only': [],
  ask: [],
  'auto-edit': [
    '*.github.com',
    'github.com',
    '*.githubusercontent.com',
    '*.npmjs.com',
    'registry.npmjs.org',
    '*.pypi.org',
    'files.pythonhosted.org',
    '*.microsoft.com',
    '*.windowsupdate.com',
  ],
  'full-access': [],
}

/**
 * 主机名是否命中一条白名单规则。支持三种写法：精确（`example.com`）、子域通配（`*.example.com`，含裸域）
 * 与裸后缀（`.example.com`）。匹配一律按小写、按标签边界 —— `evil-example.com` 不该命中 `example.com`。
 */
export function hostMatches(rule: string, host: string): boolean {
  const target = host.toLowerCase()
  const pattern = rule.toLowerCase().trim()
  if (pattern === '' || target === '') return false
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    return target === base || target.endsWith(`.${base}`)
  }
  if (pattern.startsWith('.')) {
    const base = pattern.slice(1)
    return target === base || target.endsWith(`.${base}`)
  }
  return target === pattern
}

/** 从目标里取主机名：不是合法 URL 就是 undefined（不猜、不把路径当主机）。 */
export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    /* 只有 http(s) 是网络出口；file: / data: / chrome: 之类的目标没有主机，也不该由白名单放行 */
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.hostname === '' ? undefined : parsed.hostname
  } catch {
    return undefined
  }
}

function networkDecision(
  preset: PolicyPreset,
  context: PolicyContext,
  decision: (action: PolicyAction, rule: string, reason: string) => PolicyDecision,
): PolicyDecision {
  if (preset === 'read-only') {
    return withNetwork(decision('deny', 'preset.read_only.network', '只读预设关闭网络'), {
      action: 'deny',
      rule: 'preset.read_only.network',
      reason: '只读预设关闭网络',
    })
  }
  const target = context.url
  /* 没有目标就退到原来的档位判断：产品工具只报了「这是网络」，没有可判定的主机 */
  if (target === undefined || target === '') {
    const action: PolicyAction = preset === 'full-access' ? 'allow' : 'ask'
    const rule = preset === 'full-access' ? 'preset.full_access' : 'preset.network_ask'
    const reason = preset === 'full-access' ? '完全访问' : '网络访问要确认'
    return withNetwork(decision(action, rule, reason), { action, rule, reason })
  }
  const host = hostOf(target)
  if (host === undefined) {
    return withNetwork(decision('ask', 'network.unparsed', '网络目标不是可判定的 http(s) 地址'), {
      action: 'ask',
      rule: 'network.unparsed',
      reason: '网络目标不是可判定的 http(s) 地址',
    })
  }
  const hit = NETWORK_HOSTS[preset].find((rule) => hostMatches(rule, host))
  if (hit !== undefined) {
    return withNetwork(decision('allow', 'network.allowlist', `命中出口白名单：${hit}`), {
      action: 'allow',
      rule: 'network.allowlist',
      reason: `命中出口白名单：${hit}`,
      host,
    })
  }
  const action: PolicyAction = preset === 'full-access' ? 'allow' : 'ask'
  const rule = preset === 'full-access' ? 'preset.full_access' : 'network.not_allowlisted'
  const reason = preset === 'full-access' ? '完全访问' : `目标不在出口白名单内：${host}`
  return withNetwork(decision(action, rule, reason), { action, rule, reason, host })
}

function withNetwork(decision: PolicyDecision, network: NetworkVerdict): PolicyDecision {
  return { ...decision, network }
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
