import type { AgentSkill, SkillRecord } from '@poietica/contract'
import { parse } from 'yaml'

export interface InstalledSkill {
  readonly directory: string
  readonly name: string
  readonly description: string | undefined
  readonly enabled: boolean
  readonly path: string
  readonly body: string
  readonly type: string
  readonly whenToUse: string | undefined
  readonly disableModelInvocation: boolean
  readonly supportingFiles: number
  readonly totalBytes: number
  readonly modifiedAt: number | undefined
  readonly issues: readonly string[]
}

interface ParsedSkillDocument {
  readonly name: string
  readonly description: string | undefined
  readonly body: string
  readonly type: string
  readonly whenToUse: string | undefined
  readonly disableModelInvocation: boolean
  readonly issues: readonly string[]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function firstBodyLine(body: string): string | undefined {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
}

export function skillFrontmatter(document: string): ParsedSkillDocument {
  const lines = document.split(/\r?\n/)
  const issues: string[] = []

  if (lines[0]?.trim() !== '---') {
    return {
      name: '',
      description: firstBodyLine(document),
      body: document.trim(),
      type: 'prompt',
      whenToUse: undefined,
      disableModelInvocation: false,
      issues: ['SKILL.md 缺少 YAML frontmatter。'],
    }
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closing < 0) {
    return {
      name: '',
      description: undefined,
      body: '',
      type: 'prompt',
      whenToUse: undefined,
      disableModelInvocation: false,
      issues: ['SKILL.md 缺少 frontmatter 结束分隔符。'],
    }
  }

  let fields: Record<string, unknown> = {}
  try {
    const decoded: unknown = parse(lines.slice(1, closing).join('\n'))
    if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
      fields = decoded as Record<string, unknown>
    } else {
      issues.push('frontmatter 顶层必须是映射。')
    }
  } catch (cause: unknown) {
    issues.push(cause instanceof Error ? cause.message : String(cause))
  }

  const body = lines
    .slice(closing + 1)
    .join('\n')
    .trim()
  const name = text(fields['name']) ?? ''
  const description = text(fields['description'])
  const type = text(fields['type']) ?? 'prompt'
  const whenToUse =
    text(fields['whenToUse']) ?? text(fields['when-to-use']) ?? text(fields['when_to_use'])
  const disableModelInvocation =
    boolean(fields['disableModelInvocation']) ??
    boolean(fields['disable-model-invocation']) ??
    boolean(fields['disable_model_invocation']) ??
    false

  if (name === '') {
    issues.push('目录型 SKILL.md 必须声明 name。')
  }
  if (description === undefined) {
    issues.push('目录型 SKILL.md 必须声明 description。')
  }
  if (!['prompt', 'inline', 'flow'].includes(type)) {
    issues.push(`Kimi Code 不支持 type: ${type}。`)
  }

  return {
    name,
    description,
    body,
    type,
    whenToUse,
    disableModelInvocation,
    issues,
  }
}

export function readSkills(records: readonly SkillRecord[]): readonly InstalledSkill[] {
  return records
    .map((record): InstalledSkill => {
      const parsed = skillFrontmatter(record.document)

      return {
        directory: record.name,
        name: parsed.name || record.name,
        description: parsed.description,
        enabled: record.enabled,
        path: record.path,
        body: parsed.body,
        type: parsed.type,
        whenToUse: parsed.whenToUse,
        disableModelInvocation: parsed.disableModelInvocation,
        supportingFiles: record.supportingFiles,
        totalBytes: record.totalBytes,
        modifiedAt: record.modifiedAt ?? undefined,
        issues: parsed.issues,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export interface SkillRow {
  readonly key: string
  readonly name: string
  readonly description: string | undefined
  readonly directory: string | undefined
  readonly enabled: boolean
  readonly loaded: boolean
  readonly source: string
  readonly path: string
  readonly project: string | undefined
  readonly projectPath: string | undefined
  readonly body: string | undefined
  readonly type: string | undefined
  readonly whenToUse: string | undefined
  readonly disableModelInvocation: boolean | undefined
  readonly supportingFiles: number | undefined
  readonly totalBytes: number | undefined
  readonly modifiedAt: number | undefined
  readonly issues: readonly string[]
}

/** One native snapshot in, one deterministic UI projection out. */
export function skillRows(runtime: readonly AgentSkill[]): readonly SkillRow[] {
  return runtime
    .map((skill): SkillRow => {
      const parsed = skill.document === null ? undefined : skillFrontmatter(skill.document)
      return {
        key: skill.id,
        name: parsed?.name || skill.name,
        description: parsed?.description ?? text(skill.description),
        directory: skill.directory ?? undefined,
        enabled: skill.enabled,
        loaded: skill.loaded,
        source: skill.source,
        path: skill.path,
        project: skill.project ?? undefined,
        projectPath: skill.projectPath ?? undefined,
        body: parsed?.body,
        type: parsed?.type ?? skill.kind ?? undefined,
        whenToUse: parsed?.whenToUse,
        disableModelInvocation:
          parsed?.disableModelInvocation ?? skill.disableModelInvocation ?? undefined,
        supportingFiles: skill.supportingFiles ?? undefined,
        totalBytes: skill.totalBytes ?? undefined,
        modifiedAt: skill.modifiedAt ?? undefined,
        issues: parsed?.issues ?? [],
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}
