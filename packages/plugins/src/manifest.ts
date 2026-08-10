import * as v from 'valibot'

/*
 * 插件清单的形状由 Kimi Code 拥有，不由我们定义：<plugin_root>/kimi.plugin.json，
 * 缺席时回落到 <plugin_root>/.kimi-plugin/plugin.json。两个都在时前者胜出，所以
 * 这张表是有序的：读取方按序取第一个命中的文件。
 */
export const PLUGIN_MANIFEST_FILENAMES = ['kimi.plugin.json', '.kimi-plugin/plugin.json'] as const

/*
 * 上游运行时已经不认这几个字段。读到只记一条诊断、不生效 —— 静默忽略会把
 * 「装上了却没反应」变成一个查不出原因的问题。
 */
export const UNSUPPORTED_MANIFEST_FIELDS = ['apps', 'configFile', 'inject', 'tools'] as const

/* 省略 skills 时，插件根自己就是一个技能根：根目录下那份 SKILL.md。 */
export const DEFAULT_SKILL_ROOT = './'

/* 省略 agents 时自动拾取的位置。它在不在磁盘上，由扫描那一步说了算。 */
export const DEFAULT_AGENT_ROOT = './agents'

/* 插件名同时是命令命名空间与磁盘目录名，所以约束由上游定死。 */
const PLUGIN_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/*
 * 每一个都有产出者，一个不多。扫盘、提示词预算、传输识别都不再由本应用做，它们那几
 * 条码于是不该存在 —— 一个永远不会出现的诊断码等于一句永远不会兑现的承诺。
 */
export type PluginDiagnosticCode =
  | 'hooks-not-executed'
  | 'manifest-invalid'
  | 'name-invalid'
  | 'path-escapes-root'
  | 'unsupported-field'

export interface PluginDiagnostic {
  readonly code: PluginDiagnosticCode
  readonly pluginId: string
  readonly detail: string
}

/*
 * 提示词是一串有序的来源，不是二选一。
 *
 * 上一版把 systemPrompt 与 systemPromptPath 当成互斥的两个键，两个都写就判成
 * prompt-ambiguous —— 那条规则是我们自己想出来的。官方字段表写的是「两个都在时，
 * systemPromptPath 接在 systemPrompt 之后」，所以它本来就是一个可以有两段的序列。
 */
export interface InlinePromptSource {
  readonly kind: 'inline'
  readonly text: string
}

export interface FilePromptSource {
  readonly kind: 'file'
  readonly path: string
}

export type PluginPromptSource = FilePromptSource | InlinePromptSource

/*
 * 归一之后的清单：没有可选属性。
 *
 * 技能、代理、命令三个字段在清单里都是「一条或多条 ./ 路径」，不是名字、更不是
 * 内联定义 —— 真正的技能是路径下那些 SKILL.md，真正的命令是路径下那些 .md。
 * 上一版把 commands 建模成 { name, description, body }，那个形状在上游不存在：
 * vercel-plugin 的清单写的是 "commands": ["./commands"]，按上一版会解出一条名字
 * 叫 "./commands" 的命令。
 */
export interface PluginManifest {
  readonly name: string
  readonly displayName: string
  readonly description: string | undefined
  readonly version: string | undefined
  readonly developerName: string | undefined
  readonly homepage: string | undefined
  /* interface.capabilities，插件自报的能力面，例如 Interactive / Read / Write。 */
  readonly capabilities: readonly string[]
  readonly skillRoots: readonly string[]
  readonly agentRoots: readonly string[]
  readonly commandRoots: readonly string[]
  /*
   * 清单里那张「名字 → 配置」表的名字，配置本身不进来。
   *
   * 起这些服务器的是 CLI（官方 plugins 文档：插件声明的 MCP 服务器由运行时按
   * installed.json 里的 capabilities.mcpServers.<名字>.enabled 装载）。本应用只需要
   * 名字：列一行、拨一个开关。把配置也搬进领域层，就会有人忍不住去解它。
   */
  readonly mcpServerNames: readonly string[]
  /* 新会话开始时自动装载的那个技能的名字。 */
  readonly sessionStartSkill: string | undefined
  readonly skillInstructions: string | undefined
  readonly promptSources: readonly PluginPromptSource[]
}

export interface AcceptedManifest {
  readonly kind: 'accepted'
  readonly manifest: PluginManifest
  readonly diagnostics: readonly PluginDiagnostic[]
}

export interface RejectedManifest {
  readonly kind: 'rejected'
  readonly diagnostics: readonly PluginDiagnostic[]
}

/*
 * 解析失败是预期结果，不是异常：磁盘上放着一份写坏的清单是日常，界面要把它显示
 * 成一行「这个插件为什么没生效」。所以失败是返回值，不是 throw。
 */
export type ManifestDecoding = AcceptedManifest | RejectedManifest

const InterfaceBlock = v.looseObject({
  displayName: v.optional(v.string()),
  shortDescription: v.optional(v.string()),
  developerName: v.optional(v.string()),
  websiteURL: v.optional(v.string()),
  capabilities: v.optional(v.array(v.string())),
})

/* 一条路径与一串路径在下游没有区别，差异在解码期就抹掉。 */
const PathList = v.union([v.string(), v.array(v.string())])

const RawManifest = v.looseObject({
  name: v.string(),
  version: v.optional(v.string()),
  description: v.optional(v.string()),
  homepage: v.optional(v.string()),
  interface: v.optional(InterfaceBlock),
  skills: v.optional(PathList),
  agents: v.optional(PathList),
  commands: v.optional(PathList),
  mcpServers: v.optional(v.record(v.string(), v.record(v.string(), v.unknown()))),
  sessionStart: v.optional(v.looseObject({ skill: v.optional(v.string()) })),
  skillInstructions: v.optional(v.string()),
  systemPrompt: v.optional(v.string()),
  systemPromptPath: v.optional(v.string()),
  hooks: v.optional(v.array(v.unknown())),
})

/* 落在插件根之内：以 ./ 开头（或就是 .），且没有任何一段是 ..。 */
function insideRoot(candidate: string): boolean {
  if (candidate !== '.' && !candidate.startsWith('./')) {
    return false
  }

  return !candidate.split('/').includes('..')
}

function normalizeRoots(
  name: string,
  field: string,
  declared: string | string[] | undefined,
  fallback: readonly string[],
  diagnostics: PluginDiagnostic[],
): readonly string[] {
  if (declared === undefined) {
    return fallback
  }

  const paths = typeof declared === 'string' ? [declared] : declared

  for (const candidate of paths) {
    if (!insideRoot(candidate)) {
      diagnostics.push({
        code: 'path-escapes-root',
        pluginId: name,
        detail: `${field} 里的 "${candidate}" 不在插件根之内，本次加载忽略了它`,
      })
    }
  }

  return paths.filter((candidate) => insideRoot(candidate))
}

/* 顺序就是官方字段表里的顺序：systemPrompt 在前，systemPromptPath 接在它后面。 */
function promptSourcesOf(
  inline: string | undefined,
  file: string | undefined,
): readonly PluginPromptSource[] {
  const sources: PluginPromptSource[] = []

  if (inline !== undefined && inline.trim() !== '') {
    sources.push({ kind: 'inline', text: inline })
  }

  if (file !== undefined && file.trim() !== '') {
    sources.push({ kind: 'file', path: file })
  }

  return sources
}

function unsupportedFieldDiagnostics(name: string, input: unknown): readonly PluginDiagnostic[] {
  if (typeof input !== 'object' || input === null) {
    return []
  }

  return UNSUPPORTED_MANIFEST_FIELDS.filter((field) => Object.hasOwn(input, field)).map(
    (field) => ({
      code: 'unsupported-field' as const,
      pluginId: name,
      detail: `${field} 已不被运行时支持，本次加载忽略了它`,
    }),
  )
}

/* 上游会执行 hooks，这个应用还不会。声明了却不跑必须说出来，静默忽略等于骗人。 */
function hookDiagnostics(
  name: string,
  hooks: readonly unknown[] | undefined,
): readonly PluginDiagnostic[] {
  if (hooks === undefined || hooks.length === 0) {
    return []
  }

  return [
    {
      code: 'hooks-not-executed',
      pluginId: name,
      detail: `声明了 ${hooks.length} 条 hook，这个应用还不会执行它们`,
    },
  ]
}

export function decodePluginManifest(input: unknown): ManifestDecoding {
  const parsed = v.safeParse(RawManifest, input)

  if (!parsed.success) {
    return {
      kind: 'rejected',
      diagnostics: [
        {
          code: 'manifest-invalid',
          pluginId: '',
          detail: parsed.issues.map((issue) => issue.message).join('; '),
        },
      ],
    }
  }

  const raw = parsed.output

  if (!PLUGIN_NAME.test(raw.name)) {
    return {
      kind: 'rejected',
      diagnostics: [
        {
          code: 'name-invalid',
          pluginId: raw.name,
          detail: `"${raw.name}" 不匹配 ${PLUGIN_NAME.source}`,
        },
      ],
    }
  }

  const diagnostics: PluginDiagnostic[] = [
    ...unsupportedFieldDiagnostics(raw.name, input),
    ...hookDiagnostics(raw.name, raw.hooks),
  ]

  const skills = normalizeRoots(raw.name, 'skills', raw.skills, [DEFAULT_SKILL_ROOT], diagnostics)
  const agents = normalizeRoots(raw.name, 'agents', raw.agents, [DEFAULT_AGENT_ROOT], diagnostics)
  const commands = normalizeRoots(raw.name, 'commands', raw.commands, [], diagnostics)
  const servers = Object.keys(raw.mcpServers ?? {})

  return {
    kind: 'accepted',
    diagnostics,
    manifest: {
      name: raw.name,
      displayName: raw.interface?.displayName ?? raw.name,
      description: raw.interface?.shortDescription ?? raw.description,
      version: raw.version,
      developerName: raw.interface?.developerName,
      homepage: raw.interface?.websiteURL ?? raw.homepage,
      capabilities: raw.interface?.capabilities ?? [],
      skillRoots: skills,
      agentRoots: agents,
      commandRoots: commands,
      mcpServerNames: servers,
      sessionStartSkill: raw.sessionStart?.skill,
      skillInstructions: raw.skillInstructions,
      promptSources: promptSourcesOf(raw.systemPrompt, raw.systemPromptPath),
    },
  }
}
