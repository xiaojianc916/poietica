import type { ToolCallTimelineItem } from '@poietica/agent'

/**
 * 这次调用在做什么，一句话，画在卡片没有展开的那一行上。
 *
 * 它只转述，不判断：每一句都来自派发自己交出来的字段，这一层不从工具名和参数里
 * 推测意图。宁可少说一句，不肯说错一句。
 *
 * 接第二家 agent 时这一整块搬进 AgentDialect —— 下面认的那些键是某一家的入参约定，
 * 不是协议的一部分。
 */

type ToolKind = ToolCallTimelineItem['kind']
type ToolContent = ToolCallTimelineItem['content']
type ToolLocations = ToolCallTimelineItem['locations']

/** 派发自己写给人看的那一句。它排在所有其它线索前面。 */
const SAID = 'description'

/**
 * 退而求其次的几格，按可信度排序。
 *
 * 路径三键此前也在这张表里，于是文件类派发交出来的是一条完整的绝对路径 —— 卡片那
 * 一行是给人扫一眼的，路径的前 60 个字符对它没有信息量。它们移到下面单走一路。
 */
const KEYS = ['command', 'pattern', 'query', 'url'] as const

/** 路径要的不是原文，是文件名。 */
const PATH_KEYS = ['file_path', 'filePath', 'path'] as const

/**
 * 文件类派发的动词。
 *
 * 用 Map 而不是索引签名：Record<string, string> 会让读出来的值被推成必然存在，而查
 * 表本来就可能落空 —— 那正是「这个 kind 不是文件类」这条分支的判据。
 *
 * ACP 没有「新建」这一档：写文件与改文件都落在 edit。唯一说得出两者区别的是 diff 里
 * 的 oldText 为 null（文件此前不存在），所以那一档在下面单独判。代价是运行途中 diff
 * 还没到的那几帧，这里说的是「编辑」，diff 一到改口说「新建」。
 */
const VERBS = new Map<ToolKind, string>([
  ['read', '阅读'],
  ['edit', '编辑'],
  ['delete', '删除'],
  ['move', '移动'],
])

/** 一行放不下就截断。这个数按一行能扫完的字数取，不是按存储。 */
const CLAMP = 160

export interface ToolIntent {
  /** 画出来的那一句，已经截断。 */
  readonly text: string
  /** 完整原文，挂在 title 上。 */
  readonly full: string
}

type ToolIntentSource = Pick<ToolCallTimelineItem, 'content' | 'kind' | 'locations' | 'rawInput'>

function firstLine(text: string): string {
  const cut = text.indexOf('\n')

  return (cut === -1 ? text : text.slice(0, cut)).trim()
}

/** 一段原文收成一行：取首行，过长截断。截断判据全仓只有这一处。 */
export function clampToLine(full: string): string | null {
  const said = firstLine(full)

  if (said === '') {
    return null
  }

  return said.length > CLAMP ? `${said.slice(0, CLAMP)}…` : said
}

function intentOf(full: string): ToolIntent | null {
  const text = clampToLine(full)

  return text === null ? null : { text, full }
}

/** 入参里的一格，只认非空字符串。 */
function stringOf(bag: unknown, key: string): string | null {
  if (typeof bag !== 'object' || bag === null) {
    return null
  }

  const value: unknown = Reflect.get(bag, key)

  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 路径的最后一段。
 *
 * 两个分隔符都切：这个应用只出 Windows，而 agent 交回来的路径两种写法都有 —— 它自己
 * 拼的多用正斜杠，从系统 API 取的用反斜杠。只切一种，另一种会整条漏过去。
 *
 * 末尾就是分隔符时切出空串，那时候原文比空白有用。
 */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const tail = cut === -1 ? path : path.slice(cut + 1)

  return tail === '' ? path : tail
}

/** 这次 edit 是在无中生有。判据是协议里唯一说得出这件事的那一格。 */
function createsFile(content: ToolContent): boolean {
  for (const part of content) {
    if (part.type === 'diff') {
      return part.oldText === null
    }
  }

  return false
}

function verbOf(kind: ToolKind, content: ToolContent): string | null {
  const verb = VERBS.get(kind)

  if (verb === undefined) {
    return null
  }

  return kind === 'edit' && createsFile(content) ? '新建' : verb
}

function pathOf(item: ToolIntentSource): string | null {
  for (const key of PATH_KEYS) {
    const said = stringOf(item.rawInput, key)

    if (said !== null) {
      return said
    }
  }

  return item.locations[0]?.path ?? null
}

/** 文件类派发：动词加文件名。 */
function fromFile(item: ToolIntentSource): string | null {
  const verb = verbOf(item.kind, item.content)

  if (verb === null) {
    return null
  }

  const path = pathOf(item)

  return path === null ? null : `${verb} ${basename(path)}`
}

function fromInput(rawInput: unknown): string | null {
  for (const key of KEYS) {
    const said = stringOf(rawInput, key)

    if (said !== null) {
      return said
    }
  }

  return null
}

/**
 * 最后的退路：它动过哪个文件。
 *
 * 行号那一格是 number | null | undefined —— 三种取值。此前只判了 undefined，于是
 * null 走进另一支，卡片上印出 `src/foo.ts:null`。一次 typeof 判定把两种缺席一起收掉。
 */
function fromLocations(locations: ToolLocations): string | null {
  const head = locations[0]

  if (head === undefined) {
    return null
  }

  const line = head.line
  const at = typeof line === 'number' ? `${head.path}:${String(line)}` : head.path

  return locations.length > 1 ? `${at} 等 ${String(locations.length)} 处` : at
}

/**
 * 这次调用在做什么。说不出来就返回 null，那时候卡片画派发自己的标题。
 *
 * 四档，按「谁更懂这次调用」排：
 *   派发自己写的那一句 —— 它是写给人看的，没有比它更准的；
 *   文件类的动词加文件名 —— read 这类调用通常不带上面那一句，而它做了什么，kind 和
 *     路径两个字段合起来已经说完了；
 *   命令、模式、查询、地址 —— 原样转述；
 *   动过的文件 —— 什么都没说的时候，至少说得出它碰了哪里。
 */
export function readToolIntent(item: ToolIntentSource): ToolIntent | null {
  const said =
    stringOf(item.rawInput, SAID) ??
    fromFile(item) ??
    fromInput(item.rawInput) ??
    fromLocations(item.locations)

  return said === null ? null : intentOf(said)
}
