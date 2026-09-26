import { basename } from '@poietica/review'
import type { ToolCallTimelineItem } from '../../timeline/timeline-contract'

// 首选投影层的 headline（认得工具的视图写全），认不出才退回按类别拼动词。

type ToolKind = ToolCallTimelineItem['kind']

// 只有认不出工具时才用的兜底动词；null 表示主语自己说完了。
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

// 待答的审批项也带上 headline（agent 算好的「将做什么」），与工具卡走同一条判据。
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

// ToolKind 长出新档时这里是编译错误。
function unhandled(_kind: never): string {
  return ''
}
