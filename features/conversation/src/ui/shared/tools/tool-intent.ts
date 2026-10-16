import { basename } from '@poietica/design-system/diff'
import type { ToolCallTimelineItem } from '../timeline/timeline-contract'
import { type ToolFacet, toolFamilyOf } from './tool-family'

// 优先用投影层的 headline（认得工具的视图写全），认不出才退回按类别拼动词。

type ToolKind = ToolCallTimelineItem['kind']

// null 表示主语自己说完了。
const VERB: Record<ToolKind, string | null> = {
  delegate: '派发子代理',
  edit: '编辑',
  execute: null,
  fetch: null,
  goal: '目标',
  other: null,
  read: '阅读',
  search: '搜索',
  skill: '技能',
  todo: '更新任务清单',
  write: '写入',
}

const CLAMP = 160

export function clampToLine(full: string): string | null {
  const cut = full.indexOf('\n')
  const said = (cut === -1 ? full : full.slice(0, cut)).trim()

  if (said === '') {
    return null
  }

  return said.length > CLAMP ? `${said.slice(0, CLAMP)}…` : said
}

// 待答的审批项也带上 headline（agent 算好的「将做什么」）。
type ToolLineSource = Pick<ToolCallTimelineItem, 'kind' | 'locations' | 'subject' | 'title'> & {
  readonly headline?: string | undefined
}

export function sayToolLine(item: ToolLineSource): string | null {
  const said = item.subject.trim()
  const tail = said === item.locations[0]?.path ? basename(said) : said

  if (item.headline !== undefined && item.headline !== '') {
    return clampToLine(item.headline)
  }

  const verb = VERB[item.kind]

  if (verb === null) {
    return clampToLine(tail)
  }

  return clampToLine(tail === '' ? verb : `${verb} ${tail}`)
}

export function readToolLine(item: ToolLineSource): string {
  const said = sayToolLine(item)
  if (said !== null) {
    return said
  }
  if (item.kind === 'execute') {
    return '执行命令'
  }
  if (item.kind === 'fetch') {
    return '抓取网页'
  }
  return item.title || '调用工具'
}

export function sayToolCount(kind: ToolKind, count: number): string {
  switch (kind) {
    case 'read':
      return `阅读 ${count} 个文件`
    case 'edit':
      return `编辑 ${count} 处`
    case 'write':
      return `写入 ${count} 个文件`
    case 'search':
      return `搜索 ${count} 次`
    case 'fetch':
      return `抓取 ${count} 个网页`
    case 'execute':
      return `执行 ${count} 条命令`
    case 'delegate':
      return `派出 ${count} 个子代理`
    case 'skill':
      return `动用 ${count} 个技能`
    case 'todo':
      return `更新 ${count} 次任务清单`
    case 'goal':
      return `立下 ${count} 个目标`
    case 'other':
      return `调用 ${count} 次工具`
    default:
      return unhandled(kind)
  }
}

/* 组头账目的每一笔怎么说；声明顺序就是组头里的先后（阅读 → 搜索 → 运行命令，不随谁先到而换位）。 */
const FACET_COPY: Readonly<Record<Exclude<ToolFacet, 'kind'>, (count: number) => string>> = {
  read: (n) => `读取 ${n} 个文件`,
  search: (n) => `搜索 ${n} 次`,
  execute: (n) => `运行 ${n} 条命令`,
  web_search: (n) => `搜索网络 ${n} 次`,
  fetch: (n) => `抓取 ${n} 个网页`,
  memory_read: (n) => `读取 ${n} 条记忆`,
  recall: (n) => `回忆 ${n} 次`,
  retain: (n) => `记下 ${n} 条记忆`,
  reflect: (n) => `反思 ${n} 次`,
  memory_edit: (n) => `整理 ${n} 次记忆`,
  edit: (n) => `编辑 ${n} 处`,
  write: (n) => `写入 ${n} 个文件`,
  delegate: (n) => `调度子代理 ${n} 次`,
  agent_read: (n) => `查看 ${n} 份子代理产出`,
  browser: (n) => `操作浏览器 ${n} 次`,
  computer: (n) => `操作电脑 ${n} 次`,
  skill_read: (n) => `读取 ${n} 个技能`,
  learn: (n) => `习得 ${n} 条经验`,
  skill: (n) => `管理技能 ${n} 次`,
  github: (n) => `访问 GitHub ${n} 次`,
  checkpoint: (n) => `操作回退点 ${n} 次`,
  lsp: (n) => `语言服务请求 ${n} 次`,
  mcp: (n) => `调用 ${n} 次 MCP 工具`,
  mcp_resource: (n) => `读取 ${n} 个 MCP 资源`,
}

const FACET_RANK: ReadonlyMap<string, number> = new Map(Object.keys(FACET_COPY).map((facet, rank) => [facet, rank]))

type FacetSource = Pick<ToolCallTimelineItem, 'invokedTool' | 'kind' | 'scheme'>

/**
 * 组头落定后的账目：按族里各笔分开数，例如「读取 3 个文件，搜索 2 次，运行 1 条命令」。没有的那一笔不说。
 */
export function sayFamilySummary(items: readonly FacetSource[]): string {
  const tally = new Map<string, { readonly say: (count: number) => string; readonly rank: number; count: number }>()

  for (const item of items) {
    const { facet } = toolFamilyOf(item)
    const id = facet === 'kind' ? `kind:${item.kind}` : facet
    const held = tally.get(id)

    if (held !== undefined) {
      held.count += 1
      continue
    }

    tally.set(
      id,
      facet === 'kind'
        ? { count: 1, rank: FACET_RANK.size, say: (n) => sayToolCount(item.kind, n) }
        : { count: 1, rank: FACET_RANK.get(facet) ?? FACET_RANK.size, say: FACET_COPY[facet] },
    )
  }

  return [...tally.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.say(entry.count))
    .join('，')
}

// ToolKind 长出新档时这里是编译错误。
function unhandled(_kind: never): string {
  return ''
}
