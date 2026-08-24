import type { AgentSkill } from '@poietica/agent-contract'
import type { SkillRecord } from '@poietica/ipc'
import { parse } from 'yaml'

/*
 * 「装了哪些技能」的唯一真相是本机 skills/ 目录：原生侧扫出目录名、启用状态与
 * SKILL.md 原文，前言在这里解一次。名册只回答一件事 —— 这个会话装载了没有。
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

/** 这个会话装载了哪些。名册按名字报，装载与否只在这里回答。 */
export function loadedNames(roster: readonly AgentSkill[]): ReadonlySet<string> {
  return new Set(roster.map((skill) => skill.name))
}
