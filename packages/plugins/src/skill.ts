import type { PluginDiagnostic } from './manifest'
import {
  booleanField,
  MARKDOWN_SUFFIX,
  type MarkdownFile,
  nameListField,
  parseFrontmatter,
  stringField,
} from './markdown'

/*
 * 技能不是清单里的一个名字，是磁盘上的一份 Markdown。清单只说「到哪里去找」，找到
 * 什么由这里判定 —— 目录形式、扁平形式、同名时目录形式胜出，三条都出自官方文档。
 */

const SKILL_FILENAME = 'SKILL.md'

/* 扁平技能省略 description 时回落到正文第一行非空文字，上限由官方字段表给出。 */
const DESCRIPTION_FALLBACK_LIMIT = 240

/* prompt 与 inline 语义相同；flow 只能手动调用，模型不会自己挑起它。 */
const SKILL_TYPES = ['flow', 'inline', 'prompt'] as const

export type SkillType = (typeof SKILL_TYPES)[number]

export interface PluginSkill {
  readonly pluginId: string
  readonly name: string
  readonly description: string
  readonly type: SkillType
  readonly whenToUse: string | undefined
  /*
   * 模型能不能自己挑起它。type 与 disableModelInvocation 是两个来源，能不能自动触发
   * 只有一个结论 —— 结论存在这里，两个原始字段不再往下传。
   */
  readonly modelInvocable: boolean
  readonly argumentNames: readonly string[]
  readonly path: string
  readonly invocation: string
}

export interface ResolvedSkills {
  readonly skills: readonly PluginSkill[]
  readonly diagnostics: readonly PluginDiagnostic[]
}

type SkillForm = 'directory' | 'flat' | 'none'

type SkillReading =
  | { readonly kind: 'diagnostic'; readonly diagnostic: PluginDiagnostic }
  | { readonly kind: 'skill'; readonly skill: PluginSkill }

/* 去掉 ./ 前缀与结尾斜杠，让「根」和「路径」能按同一套规则相减。 */
function trimPath(value: string): string {
  return value.replace(/^\.(?:\/|$)/u, '').replace(/\/+$/u, '')
}

function leafOf(candidate: string): string {
  return trimPath(candidate).split('/').at(-1) ?? ''
}

/* 一份文件相对声明根的位置。声明根直接指到这份文件时是空数组。 */
function tailSegments(root: string, candidate: string): readonly string[] {
  const base = trimPath(root)
  const full = trimPath(candidate)
  const rest = base === '' ? full : full.slice(base.length + 1)

  return rest === '' ? [] : rest.split('/')
}

function skillForm(rooted: boolean, segments: readonly string[], leaf: string): SkillForm {
  if (!leaf.endsWith(MARKDOWN_SUFFIX)) {
    return 'none'
  }

  /* 清单直接指到一份 .md：它自己就是那个技能。 */
  if (segments.length === 0) {
    return leaf === SKILL_FILENAME ? 'directory' : 'flat'
  }

  if (leaf === SKILL_FILENAME) {
    /*
     * <root>/SKILL.md 与 <root>/<name>/SKILL.md 都算；再深一层就是技能自带的参考
     * 资料 —— 官方例子里 references/checklist.md 就躺在 SKILL.md 旁边。
     */
    return segments.length <= 2 ? 'directory' : 'none'
  }

  /*
   * 省略 skills 时插件根不是「扫描目录」：官方措辞是「根目录下那份 SKILL.md」，
   * 所以根上的 README.md 之流不是技能。
   */
  if (rooted) {
    return 'none'
  }

  return segments.length === 1 ? 'flat' : 'none'
}

function skillTypeOf(declared: string | undefined): SkillType {
  for (const candidate of SKILL_TYPES) {
    if (candidate === declared) {
      return candidate
    }
  }

  return 'prompt'
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/u).find((candidate) => candidate.trim() !== '')

  return line === undefined ? '' : line.trim().slice(0, DESCRIPTION_FALLBACK_LIMIT)
}

/* <name>/SKILL.md 在同一层压过 <name>.md，先把被压住的文件名收齐。 */
function shadowedFlatNames(root: string, files: readonly MarkdownFile[]): ReadonlySet<string> {
  const names = new Set<string>()

  for (const file of files) {
    const segments = tailSegments(root, file.path)
    const [directory, leaf] = segments

    if (segments.length === 2 && directory !== undefined && leaf === SKILL_FILENAME) {
      names.add(`${directory}${MARKDOWN_SUFFIX}`)
    }
  }

  return names
}

function readSkill(
  pluginId: string,
  file: MarkdownFile,
  form: 'directory' | 'flat',
  leaf: string,
): SkillReading {
  const document = parseFrontmatter(file.contents)

  if (document.kind === 'malformed') {
    return {
      kind: 'diagnostic',
      diagnostic: {
        code: 'frontmatter-invalid',
        pluginId,
        detail: `${file.path} 的 frontmatter 读不出来：${document.reason}`,
      },
    }
  }

  const data = document.kind === 'parsed' ? document.data : {}
  const declaredName = stringField(data, 'name')
  const declaredDescription = stringField(data, 'description')

  /* 目录形式两个字段都必填，缺一个上游就解析失败 —— 这里也不替它编一个名字。 */
  if (form === 'directory' && (declaredName === undefined || declaredDescription === undefined)) {
    return {
      kind: 'diagnostic',
      diagnostic: {
        code: 'skill-incomplete',
        pluginId,
        detail: `${file.path} 缺少 name 或 description，目录形式的 SKILL.md 两者都必填`,
      },
    }
  }

  const name = declaredName ?? leaf.slice(0, -MARKDOWN_SUFFIX.length)
  const type = skillTypeOf(stringField(data, 'type'))
  const disabled = booleanField(
    data,
    'disableModelInvocation',
    'disable-model-invocation',
    'disable_model_invocation',
  )

  return {
    kind: 'skill',
    skill: {
      pluginId,
      name,
      description: declaredDescription ?? firstLine(document.body),
      type,
      whenToUse: stringField(data, 'whenToUse', 'when-to-use', 'when_to_use'),
      modelInvocable: type !== 'flow' && !disabled,
      argumentNames: nameListField(data, 'arguments'),
      path: file.path,
      invocation: `/skill:${name}`,
    },
  }
}

export function resolveSkills(
  pluginId: string,
  root: string,
  files: readonly MarkdownFile[],
): ResolvedSkills {
  const rooted = trimPath(root) === ''
  const shadowed = shadowedFlatNames(root, files)
  const skills: PluginSkill[] = []
  const diagnostics: PluginDiagnostic[] = []
  const taken = new Set<string>()

  for (const file of files) {
    const leaf = leafOf(file.path)
    const form = skillForm(rooted, tailSegments(root, file.path), leaf)

    if (form === 'none' || (form === 'flat' && shadowed.has(leaf))) {
      continue
    }

    const reading = readSkill(pluginId, file, form, leaf)

    if (reading.kind === 'diagnostic') {
      diagnostics.push(reading.diagnostic)
      continue
    }

    /* 官方写明技能名不分大小写，所以同名判定也不分。 */
    const key = reading.skill.name.toLowerCase()

    if (taken.has(key)) {
      diagnostics.push({
        code: 'name-taken',
        pluginId,
        detail: `技能名 "${reading.skill.name}" 出现了不止一次，${file.path} 没有生效`,
      })
      continue
    }

    taken.add(key)
    skills.push(reading.skill)
  }

  return { skills, diagnostics }
}
