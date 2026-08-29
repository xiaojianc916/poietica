import { isRecord } from '@poietica/core'
import { parse, stringify } from 'yaml'

export type ToolMode = 'all' | 'allowlist' | 'none'
export type DelegationMode = 'default' | 'all' | 'allowlist' | 'none'
export type ModelPreference = 'session' | 'primary' | 'secondary'

export interface CustomAgentDraft {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly override: boolean
  readonly toolMode: ToolMode
  readonly tools: string
  readonly disallowedTools: string
  readonly delegationMode: DelegationMode
  readonly subagents: string
  readonly modelPreference: ModelPreference
  readonly prompt: string
  readonly extras: Readonly<Record<string, unknown>>
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/

const KNOWN = new Set([
  'name',
  'description',
  'whenToUse',
  'override',
  'tools',
  'disallowedTools',
  'subagents',
  'model_preference',
])

export function emptyAgentDraft(): CustomAgentDraft {
  return {
    name: '',
    description: '',
    whenToUse: '',
    override: false,
    toolMode: 'all',
    tools: '',
    disallowedTools: '',
    delegationMode: 'default',
    subagents: '',
    modelPreference: 'session',
    prompt: '',
    extras: {},
  }
}

export function parseAgentDocument(relativePath: string, document: string): CustomAgentDraft {
  const match = FRONTMATTER.exec(document)
  if (!match) {
    throw new Error('缺少有效的 YAML frontmatter')
  }
  const yaml = match[1]
  const body = match[2]
  if (yaml === undefined || body === undefined) {
    throw new Error('frontmatter 结构不完整')
  }
  const value: unknown = parse(yaml)
  if (!isRecord(value)) {
    throw new Error('frontmatter 顶层必须是对象')
  }
  const fallback = relativePath.split('/').at(-1)?.replace(/\.md$/, '') ?? ''
  const name = optionalString(value['name']) ?? fallback
  const description = requiredString(value['description'], 'description')
  const prompt = body.trim()

  if (!NAME.test(name)) {
    throw new Error('name 必须是 kebab-case')
  }
  if (!prompt) {
    throw new Error('system prompt 不能为空')
  }

  const rawTools = stringList(value['tools'], 'tools')
  const rawSubagents = stringList(value['subagents'], 'subagents')
  const extras = Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN.has(key)))

  return {
    name,
    description,
    whenToUse: optionalString(value['whenToUse']) ?? '',
    override: value['override'] === true,
    toolMode: rawTools === undefined ? 'all' : listMode(rawTools),
    tools: rawTools?.filter((item) => item !== '*').join(', ') ?? '',
    disallowedTools: stringList(value['disallowedTools'], 'disallowedTools')?.join(', ') ?? '',
    delegationMode: rawSubagents === undefined ? 'default' : listMode(rawSubagents),
    subagents: rawSubagents?.filter((item) => item !== '*').join(', ') ?? '',
    modelPreference: parseModelPreference(value['model_preference']),
    prompt,
    extras,
  }
}

/**
 * 工具与委派清单共用的方言：['*'] 是全放行，空清单是什么都没有，其余按白名单。
 * 缺席怎么解释（tools 缺是全放行，subagents 缺是默认）只有调用方知道。
 */
function listMode(raw: string[]): ToolMode {
  if (raw.length === 1 && raw[0] === '*') {
    return 'all'
  }
  if (raw.length === 0) {
    return 'none'
  }
  return 'allowlist'
}

export function serializeAgentDocument(draft: CustomAgentDraft): string {
  const frontmatter: Record<string, unknown> = {
    name: draft.name.trim(),
    description: draft.description.trim(),
  }
  if (draft.whenToUse.trim()) {
    frontmatter['whenToUse'] = draft.whenToUse.trim()
  }
  if (draft.override) {
    frontmatter['override'] = true
  }
  if (draft.toolMode === 'allowlist') {
    frontmatter['tools'] = csv(draft.tools)
  }
  if (draft.toolMode === 'none') {
    frontmatter['tools'] = []
  }

  const denied = csv(draft.disallowedTools)
  if (denied.length > 0) {
    frontmatter['disallowedTools'] = denied
  }

  if (draft.delegationMode === 'all') {
    frontmatter['subagents'] = ['*']
  }
  if (draft.delegationMode === 'allowlist') {
    frontmatter['subagents'] = csv(draft.subagents)
  }
  if (draft.delegationMode === 'none') {
    frontmatter['subagents'] = []
  }

  if (draft.modelPreference !== 'session') {
    frontmatter['model_preference'] = draft.modelPreference
  }

  /* extras 放最后：已知键不会落进 extras，因此不存在覆盖。 */
  Object.assign(frontmatter, draft.extras)

  return (
    '---\n' +
    stringify(frontmatter, { lineWidth: 0 }).trimEnd() +
    '\n---\n' +
    draft.prompt.trim() +
    '\n'
  )
}

export function validateAgentDraft(draft: CustomAgentDraft): string | null {
  if (!NAME.test(draft.name.trim())) {
    return '名称必须使用 kebab-case，例如 code-reviewer'
  }
  if (!draft.description.trim()) {
    return '任务描述不能为空'
  }
  if (!draft.prompt.trim()) {
    return 'System prompt 不能为空'
  }
  if (draft.toolMode === 'allowlist' && csv(draft.tools).length === 0) {
    return '工具白名单不能为空'
  }
  if (draft.delegationMode === 'allowlist' && csv(draft.subagents).length === 0) {
    return '可委派 Agent 列表不能为空'
  }
  return null
}

/* 与 Kimi 的 agent-file 解析器同义：只认 primary / secondary，其余显式拒绕。 */
function parseModelPreference(value: unknown): ModelPreference {
  if (value === undefined || value === null) {
    return 'session'
  }
  if (value === 'primary' || value === 'secondary') {
    return value
  }
  throw new Error('model_preference 必须是 primary 或 secondary')
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'string') {
    return csv(value)
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} 必须是字符串或字符串数组`)
  }
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${field} 必须是字符串或字符串数组`)
    }
    if (item.trim()) {
      strings.push(item.trim())
    }
  }
  return strings
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value)
  if (!parsed) {
    throw new Error(`${field} 不能为空`)
  }
  return parsed
}
