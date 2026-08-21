import { parse } from 'yaml'

/*
 * 已装技能的领域模型，以及 SKILL.md 前言的解析。
 *
 * 技能没有账本：装载判据是 skills/<name>/SKILL.md 在不在盘上，所以「装了什么」的唯一
 * 真相是目录本身。原生侧扫目录时把 SKILL.md 原文一并交来，前言在这里解析一次，没有
 * 第二趟原生读取。
 *
 * 前言是 YAML，所以交给 YAML 解析器：引号、折叠标量、转义、注释这些边界情况已经被解决
 * 过一遍。解不开或解出来不是一张映射，都按「没有前言」处理，不阻塞安装。
 */

export interface SkillManifest {
  /** 前言里的 name，缺席时由调用方回落到目录名。 */
  readonly name: string
  readonly description: string | undefined
  readonly license: string | undefined
}

export interface InstalledSkill {
  /** 目录名，同时是 /skill:<name> 的调用名。 */
  readonly dirName: string
  readonly manifest: SkillManifest
}

export function parseSkillFrontmatter(md: string): SkillManifest {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const block = frontmatter(match?.[1])

  return {
    name: field(block, 'name') ?? '',
    description: field(block, 'description'),
    license: field(block, 'license'),
  }
}

function frontmatter(source: string | undefined): Record<string, unknown> {
  if (source === undefined) {
    return {}
  }

  try {
    const parsed: unknown = parse(source)

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/* 只认非空字符串标量：数字、布尔、列表出现在这三格里都是写错了，按缺席处理。 */
function field(block: Record<string, unknown>, key: string): string | undefined {
  const value = block[key]

  return typeof value === 'string' && value !== '' ? value : undefined
}

export function decodeSkillPayload(payload: { name: string; skillMd: string }): InstalledSkill {
  const manifest = parseSkillFrontmatter(payload.skillMd)

  return {
    dirName: payload.name,
    manifest: { ...manifest, name: manifest.name === '' ? payload.name : manifest.name },
  }
}
