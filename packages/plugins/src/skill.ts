import type { AgentSkill } from '@poietica/agent-contract'
import { parse } from 'yaml'

/*
 * 技能的两半真相在这里合成一张表。
 *
 * 「会话里有哪些技能」由 kap 名册说了算：agent 合并它自己的几层目录后报来
 * （driver.rs 的 list_skills）。本机 skills/ 目录只是写入目标，只回答「哪些是这里
 * 装的」。与本仓 mcp-servers.ts::resolveMcpServers 同一条范式：多来源合成一张表，
 * 界面只画这张表。
 *
 * 渲染层唯一还要碰 SKILL.md 前言的地方，是安装落盘前取目录名。
 */

export interface ResolvedSkill {
  readonly name: string
  /** 名册给的说明；名册没报就没有。 */
  readonly description: string | undefined
  /** 名册给的来源（哪一层带来的）；名册没报就没有。 */
  readonly source: string | undefined
  /** 名册报了它：这个会话真的装载了。 */
  readonly served: boolean
  /** 本机 skills/ 里装着：只有这一类行删得掉。 */
  readonly owned: boolean
}

export function resolveSkills(input: {
  readonly roster: readonly AgentSkill[]
  readonly owned: readonly string[]
}): readonly ResolvedSkill[] {
  const here = new Set(input.owned)

  const reported = input.roster.map(
    (skill): ResolvedSkill => ({
      name: skill.name,
      description: skill.description === '' ? undefined : skill.description,
      source: skill.source === '' ? undefined : skill.source,
      served: true,
      owned: here.has(skill.name),
    }),
  )

  /* 本机装着、名册却没报的：装了却没装载，第一次被说出来。 */
  const served = new Set(input.roster.map((skill) => skill.name))
  const unserved = input.owned
    .filter((name) => !served.has(name))
    .map(
      (name): ResolvedSkill => ({
        name,
        description: undefined,
        source: undefined,
        served: false,
        owned: true,
      }),
    )

  return [...reported, ...unserved].sort((left, right) => left.name.localeCompare(right.name))
}

/** 前言里的 name；解不开或缺席时交回空串，调用方回落到目录名。 */
export function skillFrontmatterName(md: string): string {
  const block = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]

  if (block === undefined) {
    return ''
  }

  try {
    const parsed: unknown = parse(block)
    const name =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['name']
        : undefined

    return typeof name === 'string' && name !== '' ? name : ''
  } catch {
    return ''
  }
}
