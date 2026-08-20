import type { ToolCallTimelineItem } from '@poietica/agent'

/**
 * 这次调用在做什么，一句话，画在卡片没有展开的那一行上。
 *
 * 类别与主语由投影从 kap 的 display 定完（kap-projection.ts），这一层只挑动词、
 * 取文件名、按一行收口 —— 不读入参，不猜。
 */

type ToolKind = ToolCallTimelineItem['kind']

/** 动词。缺席表示主语自己已经说完了（命令、地址、摘要）。 */
const VERB: Record<ToolKind, string | null> = {
  delegate: '派发',
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

/**
 * 路径的最后一段。
 *
 * 两个分隔符都切：这个应用只出 Windows，而 agent 交回来的路径两种写法都有。
 * 末尾就是分隔符时切出空串，那时候原文比空白有用。
 */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const tail = cut === -1 ? path : path.slice(cut + 1)

  return tail === '' ? path : tail
}

type ToolLineSource = Pick<ToolCallTimelineItem, 'kind' | 'locations' | 'subject' | 'title'>

/** 有动词就配文件名，没动词就转述主语；说不出来退回工具名。 */
export function readToolLine(item: ToolLineSource): string {
  const verb = VERB[item.kind]
  const said = item.subject.trim()
  const tail = said === item.locations[0]?.path ? basename(said) : said

  if (verb === null) {
    return clampToLine(tail) ?? item.title
  }

  return clampToLine(tail === '' ? verb : `${verb} ${tail}`) ?? item.title
}
