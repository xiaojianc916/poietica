import type { SkillRecord } from '@poietica/contract'
import { parse } from 'yaml'

/*
 * 「有哪些技能」的唯一真相是 agent 的名册，几层技能目录的合并归它。
 *
 * 本机 skills/ 是其中我们写得动的那一层：原生侧扫出目录名、启用状态与 SKILL.md 原文，前言
 * 在这里解一次，开关与移除按目录名寻址。停用即改名，改名之后 agent 不再报它 —— 所以两边并
 * 成一张表，才既列得全又开得动。
 */

export interface InstalledSkill {
  /** 目录名。停用、启用、卸载都按它寻址。 */
  readonly directory: string
  /** 前言里的 name；缺席回落到目录名。 */
  readonly name: string
  readonly description: string | undefined
  /** SKILL.md 在盘上是不是叫这个名字（改名即停用）。 */
  readonly enabled: boolean
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 前言里的 name 与 description。解不开就当没写。 */
export function skillFrontmatter(document: string): {
  readonly name: string
  readonly description: string | undefined
} {
  const block = document.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]

  if (block === undefined) {
    return { name: '', description: undefined }
  }

  let parsed: unknown

  try {
    parsed = parse(block)
  } catch {
    return { name: '', description: undefined }
  }

  const fields =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}

  return { name: text(fields['name']) ?? '', description: text(fields['description']) }
}

/** 原生侧报来的目录，解成屏幕上那几行。 */
export function readSkills(records: readonly SkillRecord[]): readonly InstalledSkill[] {
  return records
    .map((record): InstalledSkill => {
      const front = skillFrontmatter(record.document)

      return {
        directory: record.name,
        name: front.name === '' ? record.name : front.name,
        description: front.description,
        enabled: record.enabled,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** 屏幕上那一行：一个名字一行。 */
export interface SkillRow {
  readonly name: string
  readonly description: string | undefined
  /** 本机 skills/ 里的目录名；开关与移除按它寻址。别处来的没有这一格。 */
  readonly directory: string | undefined
  /** SKILL.md 没被改名。别处来的恒为真：那些文件不归我们改。 */
  readonly enabled: boolean
  /** 这个会话装载了它。 */
  readonly loaded: boolean
  /** 别处来的那一层由 agent 报（project / user / extra）；我们这一层没有这一格。 */
  readonly source: string | undefined
}

/**
 * 名册里一条技能的最小前提：这里只读这三个字段。
 *
 * 不直接引用会话领域的 AgentSkill —— 扩展域不依赖对话域；形状由调用侧
 * （surfaces 的 extension/ 拿着名册）结构化地满足。
 */
export interface RosterSkill {
  readonly name: string
  readonly description: string
  readonly source: string
}

/*
 * 名册与本机那一层并成一张表。
 *
 * 缺哪一边都会说谎：只看磁盘，别的层里的技能一行都不显示；只看名册，停用的那些连开关都找
 * 不回来（改名之后 agent 不报它）。名字是两边共同的号，与提交时那一格（PromptSkill.name）
 * 同一个。
 */
export function skillRows(
  installed: readonly InstalledSkill[],
  roster: readonly RosterSkill[],
): readonly SkillRow[] {
  const reported = new Map(roster.map((skill) => [skill.name, skill] as const))
  const ours = new Set(installed.map((skill) => skill.name))

  const rows: SkillRow[] = installed.map((skill) => ({
    name: skill.name,
    description: skill.description ?? text(reported.get(skill.name)?.description),
    directory: skill.directory,
    enabled: skill.enabled,
    loaded: reported.has(skill.name),
    source: undefined,
  }))

  for (const skill of roster) {
    if (ours.has(skill.name)) {
      continue
    }

    rows.push({
      name: skill.name,
      description: text(skill.description),
      directory: undefined,
      enabled: true,
      loaded: true,
      source: skill.source,
    })
  }

  return rows.sort((left, right) => left.name.localeCompare(right.name))
}
