/*
 * 已装技能的领域模型，以及 SKILL.md 前言的最小解析。
 *
 * 技能没有账本：装载判据是 skills/<name>/SKILL.md 在不在盘上，所以「装了什么」的唯一
 * 真相是目录本身。原生侧扫目录时把 SKILL.md 原文一并交来，前言在这里解析一次，没有
 * 第二趟原生读取。
 *
 * 前言是 YAML 的一个受限子集：只认各占一行的 name/description/license 三个键，值裸写
 * 或用双引号包（引号串里只解 \" 与 \\ 两种转义）。anthropics/skills 的前言全部落在这个
 * 子集里；解不出的字段按缺席处理，不阻塞安装。
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
  const block = match?.[1] ?? ''

  return {
    name: field(block, 'name') ?? '',
    description: field(block, 'description'),
    license: field(block, 'license'),
  }
}

function field(block: string, key: string): string | undefined {
  const hit = block.match(new RegExp(`^${key}:[ \t]*(.+)$`, 'm'))

  const raw = hit?.[1]?.trim()

  if (raw === undefined) {
    return undefined
  }

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }

  return raw
}

export function decodeSkillPayload(payload: { name: string; skillMd: string }): InstalledSkill {
  const manifest = parseSkillFrontmatter(payload.skillMd)

  return {
    dirName: payload.name,
    manifest: { ...manifest, name: manifest.name === '' ? payload.name : manifest.name },
  }
}
