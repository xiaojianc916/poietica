import { parse } from 'yaml'

/*
 * 技能与命令都是「YAML frontmatter + Markdown 正文」的文件。这个模块只做两件事：
 * 把两段分开，把上半段读成一组键值。
 *
 * YAML 交给 yaml 包。frontmatter 里真实出现过块标量（kimi-code 官方插件
 * kimi-datasource 的 SKILL.md 用 description: | 写了一段跨行说明）和带冒号带引号的
 * 单行（vercel-plugin 的 commands/deploy.md）。按第一个冒号切开的行解析器对这两种
 * 都会读错，读错的后果是描述缺半句、或者整条技能消失 —— 这属于「已经被解决、边界
 * 情况多到手写必然漏」的那一类。
 *
 * 围栏切分留在自己手里：三横线是 Markdown 侧的约定，不属于 YAML，也没有边界情况。
 */

const FENCE = '---'

/* 编辑器与 Windows 工具链会在文件开头写 BOM，它会让第一行不再等于三横线。 */
const BYTE_ORDER_MARK = '\uFEFF'

/* 技能与命令都是 Markdown。「哪个后缀算数」是插件域的语义，原生侧不认识它。 */
export const MARKDOWN_SUFFIX = '.md'

export interface MarkdownFile {
  /* 相对插件根，回头重读原文时原样传回去。 */
  readonly path: string
  readonly contents: string
}

export interface AbsentFrontmatter {
  readonly kind: 'absent'
  readonly body: string
}

export interface MalformedFrontmatter {
  readonly kind: 'malformed'
  readonly reason: string
  readonly body: string
}

export interface ParsedFrontmatter {
  readonly kind: 'parsed'
  readonly data: Readonly<Record<string, unknown>>
  readonly body: string
}

/*
 * 读不出来是预期结果，不是异常：磁盘上放着一份写坏的 SKILL.md 是日常，界面要把它
 * 显示成一行「这条技能为什么没生效」。所以失败是返回值，不是 throw。
 */
export type Frontmatter = AbsentFrontmatter | MalformedFrontmatter | ParsedFrontmatter

export function parseFrontmatter(source: string): Frontmatter {
  const text = source.startsWith(BYTE_ORDER_MARK) ? source.slice(BYTE_ORDER_MARK.length) : source
  const lines = text.split(/\r?\n/u)

  if (lines[0]?.trim() !== FENCE) {
    return { kind: 'absent', body: text }
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE)

  if (closing === -1) {
    return { kind: 'absent', body: text }
  }

  const body = lines.slice(closing + 1).join('\n')

  try {
    const data: unknown = parse(lines.slice(1, closing).join('\n'))

    /* 空围栏是合法的，yaml 对它返回 null —— 那是一组空键值，不是读坏了。 */
    if (data === null || data === undefined) {
      return { kind: 'parsed', data: {}, body }
    }

    if (typeof data !== 'object' || Array.isArray(data)) {
      return { kind: 'malformed', reason: 'frontmatter 不是一组键值', body }
    }

    return { kind: 'parsed', data: data as Readonly<Record<string, unknown>>, body }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)

    return { kind: 'malformed', reason, body }
  }
}

/* 多个键名按顺序试，第一个有内容的胜出：官方字段表给出的别名就是这么用的。 */
export function stringField(
  data: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = data[key]

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }

  return undefined
}

export function booleanField(
  data: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): boolean {
  return keys.some((key) => data[key] === true)
}

/* arguments 允许写成数组，也允许写成一串以空白分隔的名字。 */
export function nameListField(
  data: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = data[key]

  if (typeof value === 'string') {
    return value
      .trim()
      .split(/\s+/u)
      .filter((name) => name !== '')
  }

  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim())
}
