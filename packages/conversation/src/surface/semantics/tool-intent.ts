import { basename } from '@poietica/review'
import type { ToolCallTimelineItem } from '../../timeline/timeline-contract'

/** 类别与主语归投影，这里只负责一行文案。 */

type ToolKind = ToolCallTimelineItem['kind']

/** 动词。缺席表示主语自己已经说完了（命令、地址、摘要）。 */
const VERB: Record<ToolKind, string | null> = {
  delegate: '派发子代理',
  edit: '编辑',
  execute: null,
  fetch: null,
  goal: '目标',
  other: null,
  plan: '计划',
  read: '阅读',
  search: '搜索',
  skill: '技能',
  task: '任务',
  todo: '更新任务清单',
  write: '写入',
}

/** 一行放不下就截断。这个数按一行能扫完的字数取，不是按存储。 */
const CLAMP = 160

/** 一段原文收成一行：取首行，过长截断。截断判据全仓只有这一处。 */
export function clampToLine(full: string): string | null {
  const cut = full.indexOf('\n')
  const said = (cut === -1 ? full : full.slice(0, cut)).trim()

  if (said === '') {
    return null
  }

  return said.length > CLAMP ? `${said.slice(0, CLAMP)}…` : said
}

type ToolLineSource = Pick<ToolCallTimelineItem, 'kind' | 'locations' | 'subject' | 'title'>

export function sayToolLine(item: ToolLineSource): string | null {
  const verb = VERB[item.kind]
  const said = item.subject.trim()
  const tail = said === item.locations[0]?.path ? basename(said) : said

  if (verb === null) {
    return clampToLine(tail)
  }

  return clampToLine(tail === '' ? verb : `${verb} ${tail}`)
}

/** 等待参数时仍显示已知类别，未识别身份才显示原名。 */
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

/**
 * 一类调用做了几次，一句话：收起时的汇总头。
 *
 * 一类一句，量词跟着这一类真正在数的东西走。中文不变复数，所以没有单复数分支。
 */
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
    case 'task':
      return `推进 ${count} 项任务`
    case 'todo':
      return `更新 ${count} 次任务清单`
    case 'plan':
      return `修订 ${count} 次计划`
    case 'goal':
      return `立下 ${count} 个目标`
    case 'other':
      return `调用 ${count} 次工具`
    default:
      return unhandled(kind)
  }
}

/* ToolKind 长出新的一档时这里是编译错误，不是一行空白。 */
function unhandled(_kind: never): string {
  return ''
}
