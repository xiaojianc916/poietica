import type { SkillDocument, SkillDocumentFacts } from '@poietica/feature-conversation/ui-api'
import type { SkillInfo } from '../contract'

/* 一份 SKILL.md 读出来的那几格照 legacy。这里只做行级 frontmatter 取值而不用 yaml 包：解析结果要交给 conversation 的面板渲染，
 * 而 yaml 不在 ui 子入口允许的依赖表里，为几个标量字段把整份解析器拖进渲染进程不划算。代价是块状标量（description: |）读成字面量。 */

const TEXT = /^(.*)$/u

function scalar(raw: string): string | undefined {
  const trimmed = raw.trim()

  if (trimmed === '' || trimmed === 'null' || trimmed === '~') {
    return undefined
  }

  return trimmed.replace(/^['"]|['"]$/gu, '').trim()
}

function field(lines: readonly string[], closing: number, keys: readonly string[]): string | undefined {
  for (const line of lines.slice(1, closing)) {
    const at = line.indexOf(':')

    if (at < 0 || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-')) {
      continue
    }

    if (!keys.includes(line.slice(0, at).trim())) {
      continue
    }

    const value = scalar(line.slice(at + 1))

    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

export function skillDocumentFacts(markdown: string): SkillDocumentFacts {
  const lines = markdown.split(/\r?\n/)
  const issues: string[] = []

  if (lines[0]?.trim() !== '---') {
    const first = lines.map((line) => line.trim()).find((line) => line !== '')

    return {
      name: '',
      description: first === undefined || !TEXT.test(first) ? undefined : first,
      body: markdown.trim(),
      type: undefined,
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
      type: undefined,
      whenToUse: undefined,
      disableModelInvocation: false,
      issues: ['SKILL.md 缺少 frontmatter 结束分隔符。'],
    }
  }

  const body = lines
    .slice(closing + 1)
    .join('\n')
    .trim()
  const name = field(lines, closing, ['name']) ?? ''
  const description = field(lines, closing, ['description'])
  const type = field(lines, closing, ['type'])
  const whenToUse = field(lines, closing, ['whenToUse', 'when-to-use', 'when_to_use'])
  const disableModelInvocation = ['disableModelInvocation', 'disable-model-invocation', 'disable_model_invocation']
    .map((key) => field(lines, closing, [key]))
    .includes('true')

  if (name === '') {
    issues.push('目录型 SKILL.md 必须声明 name。')
  }
  if (description === undefined) {
    issues.push('目录型 SKILL.md 必须声明 description。')
  }
  if (type !== undefined && !['prompt', 'inline', 'flow'].includes(type)) {
    issues.push(`当前 agent 不支持 type: ${type}。`)
  }

  return { name, description, body, type, whenToUse, disableModelInvocation, issues }
}

export function skillDocumentOf(skill: SkillInfo, markdown: string): SkillDocument {
  const facts = skillDocumentFacts(markdown)

  return {
    markdown,
    name: facts.name === '' ? skill.name : facts.name,
    path: skill.path,
    facts,
  }
}
